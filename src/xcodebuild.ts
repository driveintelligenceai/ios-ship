import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface BuildConfig {
  projectPath: string;    // path to .xcodeproj or .xcworkspace
  scheme: string;         // scheme name (usually same as app name)
  configuration: string;  // Debug or Release
  archivePath: string;    // where to save the .xcarchive
  exportPath: string;     // where to export the .ipa
  exportOptionsPlist: string; // path to ExportOptions.plist
  teamId?: string;
}

export function generateExportOptionsPlist(config: {
  bundleId: string;
  teamId: string;
  method?: 'app-store' | 'ad-hoc' | 'development';
}): string {
  const method = config.method ?? 'app-store';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${method}</string>
  <key>teamID</key>
  <string>${config.teamId}</string>
  <key>uploadSymbols</key>
  <true/>
  <key>compileBitcode</key>
  <false/>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>`;
}

export async function buildAndArchive(
  config: BuildConfig,
  onLog: (line: string) => void
): Promise<void> {
  const isWorkspace = config.projectPath.endsWith('.xcworkspace');
  const projectFlag = isWorkspace ? '-workspace' : '-project';

  const args = [
    projectFlag, config.projectPath,
    '-scheme', config.scheme,
    '-configuration', config.configuration,
    '-destination', 'generic/platform=iOS',
    '-archivePath', config.archivePath,
    'archive',
    'CODE_SIGN_IDENTITY=iPhone Distribution',
    'CODE_SIGN_STYLE=Automatic',
  ];

  await runXcodebuild(args, onLog);
}

export async function exportArchive(
  config: BuildConfig,
  onLog: (line: string) => void
): Promise<string> {
  const args = [
    '-exportArchive',
    '-archivePath', config.archivePath,
    '-exportPath', config.exportPath,
    '-exportOptionsPlist', config.exportOptionsPlist,
  ];

  await runXcodebuild(args, onLog);

  // Find the .ipa
  const files = fs.readdirSync(config.exportPath);
  const ipa = files.find(f => f.endsWith('.ipa'));
  if (!ipa) throw new Error('No .ipa found after export');
  return path.join(config.exportPath, ipa);
}

function runXcodebuild(
  args: string[],
  onLog: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('xcodebuild', args, { stdio: 'pipe' });
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (
          line.includes('error:') ||
          line.includes('warning:') ||
          line.includes('Build succeeded') ||
          line.includes('Archive succeeded') ||
          line.includes('BUILD SUCCEEDED') ||
          line.includes('** ARCHIVE SUCCEEDED **') ||
          line.includes('** EXPORT SUCCEEDED **')
        ) {
          onLog(line.trim());
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`xcodebuild exited with code ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

export function detectScheme(projectPath: string): string {
  // Extract scheme from xcodeproj name
  const basename = path.basename(projectPath, '.xcodeproj');
  return basename;
}

export function findXcodeProject(dir: string): string | null {
  const entries = fs.readdirSync(dir);
  const workspace = entries.find(e => e.endsWith('.xcworkspace') && !e.includes('.xcodeproj'));
  if (workspace) return path.join(dir, workspace);
  const project = entries.find(e => e.endsWith('.xcodeproj'));
  if (project) return path.join(dir, project);
  return null;
}
