#!/usr/bin/env node
/**
 * ios-ship CLI
 * Build, archive, and upload iOS apps to TestFlight.
 *
 * Usage:
 *   ios-ship build <project-dir>         Build and archive
 *   ios-ship upload <archive-path>        Upload .xcarchive to TestFlight
 *   ios-ship ship <project-dir>           Full pipeline: build + upload + submit
 *   ios-ship status <bundle-id>           Check TestFlight build status
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import {
  buildAndArchive,
  exportArchive,
  generateExportOptionsPlist,
  findXcodeProject,
  detectScheme,
} from './xcodebuild.js';
import {
  uploadToTestFlight,
  findApp,
  getTestFlightBuilds,
  submitForReview,
} from './appstore-connect.js';

const program = new Command();

program
  .name('ios-ship')
  .description('Build and ship iOS apps to TestFlight')
  .version('1.0.0');

function getConfig() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const privateKeyPath = process.env.ASC_KEY_PATH;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!keyId || !issuerId || !privateKeyPath) {
    console.error(chalk.red('\nMissing App Store Connect credentials.'));
    console.error('Set these environment variables (via .env.tpl or op run):');
    console.error('  ASC_KEY_ID       — App Store Connect API Key ID');
    console.error('  ASC_ISSUER_ID    — App Store Connect Issuer ID');
    console.error('  ASC_KEY_PATH     — Path to .p8 private key file');
    console.error('  APPLE_TEAM_ID    — Apple Developer Team ID\n');
    process.exit(1);
  }

  return { keyId, issuerId, privateKeyPath, teamId: teamId || '' };
}

// ── build ────────────────────────────────────────────────────────────────────
program
  .command('build <project-dir>')
  .description('Build and archive an Xcode project')
  .option('-s, --scheme <scheme>', 'Xcode scheme name')
  .option('-c, --config <configuration>', 'Build configuration', 'Release')
  .option('-o, --output <path>', 'Archive output path')
  .action(async (projectDir: string, options) => {
    const absoluteDir = path.resolve(projectDir);
    const projectPath = findXcodeProject(absoluteDir);
    if (!projectPath) {
      console.error(chalk.red(`No .xcodeproj or .xcworkspace found in ${absoluteDir}`));
      process.exit(1);
    }

    const scheme = options.scheme || detectScheme(projectPath);
    const archivePath = options.output || path.join(absoluteDir, `${scheme}.xcarchive`);
    const config = getConfig();

    const spinner = ora(`Building ${scheme}...`).start();
    const logs: string[] = [];

    try {
      await buildAndArchive(
        {
          projectPath,
          scheme,
          configuration: options.config,
          archivePath,
          exportPath: '',
          exportOptionsPlist: '',
          teamId: config.teamId,
        },
        line => {
          logs.push(line);
          if (line.includes('error:')) {
            spinner.text = chalk.red(line.slice(0, 80));
          } else if (line.includes('BUILD SUCCEEDED') || line.includes('ARCHIVE SUCCEEDED')) {
            spinner.text = chalk.green(line);
          }
        }
      );

      spinner.succeed(chalk.green(`Archived to ${archivePath}`));
    } catch (err) {
      spinner.fail(chalk.red('Build failed'));
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── upload ───────────────────────────────────────────────────────────────────
program
  .command('upload <archive-path>')
  .description('Export and upload a .xcarchive to TestFlight')
  .option('--bundle-id <id>', 'App bundle ID (required for export options)')
  .action(async (archivePath: string, options) => {
    const absoluteArchive = path.resolve(archivePath);
    if (!fs.existsSync(absoluteArchive)) {
      console.error(chalk.red(`Archive not found: ${absoluteArchive}`));
      process.exit(1);
    }

    const config = getConfig();
    const exportPath = absoluteArchive.replace('.xcarchive', '-export');
    const exportPlistPath = path.join(os.tmpdir(), 'ExportOptions.plist');

    fs.writeFileSync(
      exportPlistPath,
      generateExportOptionsPlist({
        bundleId: options.bundleId || '*',
        teamId: config.teamId,
        method: 'app-store',
      })
    );

    const spinner = ora('Exporting archive...').start();

    try {
      const ipaPath = await exportArchive(
        {
          projectPath: '',
          scheme: '',
          configuration: 'Release',
          archivePath: absoluteArchive,
          exportPath,
          exportOptionsPlist: exportPlistPath,
        },
        line => { spinner.text = line.slice(0, 80); }
      );

      spinner.text = 'Uploading to TestFlight...';

      await uploadToTestFlight(ipaPath, config, line => {
        spinner.text = line.slice(0, 80);
      });

      spinner.succeed(chalk.green('Uploaded to TestFlight!'));
      console.log(chalk.cyan('\nThe build will appear in App Store Connect within a few minutes.'));
    } catch (err) {
      spinner.fail(chalk.red('Upload failed'));
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── ship ─────────────────────────────────────────────────────────────────────
program
  .command('ship <project-dir>')
  .description('Full pipeline: build → archive → upload → submit for TestFlight review')
  .option('-s, --scheme <scheme>', 'Xcode scheme name')
  .option('--bundle-id <id>', 'App bundle identifier')
  .option('--submit', 'Submit for TestFlight review after upload', false)
  .action(async (projectDir: string, options) => {
    const absoluteDir = path.resolve(projectDir);
    const projectPath = findXcodeProject(absoluteDir);
    if (!projectPath) {
      console.error(chalk.red(`No .xcodeproj found in ${absoluteDir}`));
      process.exit(1);
    }

    const scheme = options.scheme || detectScheme(projectPath);
    const archivePath = path.join(absoluteDir, `${scheme}.xcarchive`);
    const exportPath = path.join(absoluteDir, `${scheme}-export`);
    const exportPlistPath = path.join(os.tmpdir(), `${scheme}-ExportOptions.plist`);
    const config = getConfig();

    const bundleId = options.bundleId || `com.driveintelligence.${scheme.toLowerCase()}`;

    fs.writeFileSync(
      exportPlistPath,
      generateExportOptionsPlist({ bundleId, teamId: config.teamId, method: 'app-store' })
    );

    console.log(chalk.bold.cyan(`\n🚀 Shipping ${scheme} to TestFlight\n`));

    // Step 1: Build
    let spinner = ora('1/4 Building and archiving...').start();
    try {
      await buildAndArchive(
        { projectPath, scheme, configuration: 'Release', archivePath, exportPath, exportOptionsPlist: exportPlistPath, teamId: config.teamId },
        line => { if (line.includes('error:') || line.includes('SUCCEEDED')) spinner.text = line.slice(0, 80); }
      );
      spinner.succeed('1/4 Build and archive complete');
    } catch (err) {
      spinner.fail('1/4 Build failed');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    // Step 2: Export
    spinner = ora('2/4 Exporting .ipa...').start();
    let ipaPath: string;
    try {
      ipaPath = await exportArchive(
        { projectPath, scheme, configuration: 'Release', archivePath, exportPath, exportOptionsPlist: exportPlistPath },
        line => { spinner.text = line.slice(0, 80); }
      );
      spinner.succeed(`2/4 Exported: ${path.basename(ipaPath)}`);
    } catch (err) {
      spinner.fail('2/4 Export failed');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    // Step 3: Upload
    spinner = ora('3/4 Uploading to TestFlight...').start();
    try {
      await uploadToTestFlight(ipaPath, config, line => { spinner.text = line.slice(0, 80); });
      spinner.succeed('3/4 Uploaded to TestFlight');
    } catch (err) {
      spinner.fail('3/4 Upload failed');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }

    // Step 4: Submit (optional)
    if (options.submit) {
      spinner = ora('4/4 Submitting for review...').start();
      try {
        const app = await findApp(bundleId, config);
        if (!app) throw new Error(`App with bundle ID ${bundleId} not found in App Store Connect`);
        await submitForReview(app.id, config);
        spinner.succeed('4/4 Submitted for TestFlight review!');
      } catch (err) {
        spinner.fail('4/4 Submit failed (build may need a few minutes to process first)');
        console.error(chalk.yellow(err instanceof Error ? err.message : String(err)));
      }
    }

    console.log(chalk.bold.green('\n✅ Done! Check App Store Connect for build status.\n'));
  });

// ── status ───────────────────────────────────────────────────────────────────
program
  .command('status <bundle-id>')
  .description('Check TestFlight build status for an app')
  .action(async (bundleId: string) => {
    const config = getConfig();
    const spinner = ora('Fetching build status...').start();

    try {
      const app = await findApp(bundleId, config);
      if (!app) {
        spinner.fail(`No app found with bundle ID: ${bundleId}`);
        process.exit(1);
      }

      const builds = await getTestFlightBuilds(app.id, config);
      spinner.stop();

      console.log(chalk.bold(`\n📱 ${app.name} (${bundleId})\n`));

      if (builds.length === 0) {
        console.log(chalk.gray('  No builds found'));
      } else {
        for (const b of builds) {
          const statusColor =
            b.status === 'VALID' ? chalk.green :
            b.status === 'IN_BETA_REVIEW' ? chalk.cyan :
            b.status === 'REJECTED' ? chalk.red :
            chalk.gray;
          console.log(`  ${statusColor(`● ${b.status.padEnd(20)}`)} v${b.version} (${b.buildNumber})`);
        }
      }
      console.log();
    } catch (err) {
      spinner.fail('Failed to fetch status');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse();
