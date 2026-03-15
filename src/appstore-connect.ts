/**
 * App Store Connect API client.
 * Handles JWT auth and TestFlight upload via altool.
 */
import { SignJWT } from 'jose';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

export interface AppStoreConnectConfig {
  keyId: string;         // App Store Connect API Key ID
  issuerId: string;      // App Store Connect Issuer ID
  privateKeyPath: string; // Path to .p8 private key file
}

export async function generateJWT(config: AppStoreConnectConfig): Promise<string> {
  const fs = await import('fs');
  const privateKeyPem = fs.readFileSync(config.privateKeyPath, 'utf-8');
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })
    .setIssuer(config.issuerId)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('20m')
    .sign(privateKey);

  return jwt;
}

export interface AppInfo {
  id: string;
  bundleId: string;
  name: string;
}

export async function findApp(
  bundleId: string,
  config: AppStoreConnectConfig
): Promise<AppInfo | null> {
  const token = await generateJWT(config);
  const res = await fetch(
    `https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=${bundleId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`App Store Connect API error: ${res.status} ${await res.text()}`);

  const data = await res.json() as { data: { id: string; attributes: { bundleId: string; name: string } }[] };
  const app = data.data[0];
  if (!app) return null;

  return {
    id: app.id,
    bundleId: app.attributes.bundleId,
    name: app.attributes.name,
  };
}

export async function getTestFlightBuilds(
  appId: string,
  config: AppStoreConnectConfig
): Promise<{ version: string; buildNumber: string; status: string }[]> {
  const token = await generateJWT(config);
  const res = await fetch(
    `https://api.appstoreconnect.apple.com/v1/apps/${appId}/builds?limit=10&sort=-uploadedDate`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`App Store Connect API error: ${res.status}`);

  const data = await res.json() as {
    data: {
      id: string;
      attributes: {
        version: string;
        uploadedDate: string;
        processingState: string;
      };
    }[];
  };

  return data.data.map(b => ({
    version: b.attributes.version,
    buildNumber: b.id,
    status: b.attributes.processingState,
  }));
}

export async function uploadToTestFlight(
  ipaPath: string,
  config: AppStoreConnectConfig,
  onLog: (line: string) => void
): Promise<void> {
  // Use xcrun altool to upload (works without Xcode GUI)
  const args = [
    'altool',
    '--upload-app',
    '--type', 'ios',
    '--file', ipaPath,
    '--apiKey', config.keyId,
    '--apiIssuer', config.issuerId,
    '--output-format', 'xml',
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('xcrun', args, { stdio: 'pipe' });

    proc.stdout?.on('data', (data: Buffer) => {
      onLog(data.toString().trim());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      onLog(data.toString().trim());
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`altool upload failed with code ${code}`));
      }
    });
  });
}

export async function submitForReview(
  appId: string,
  config: AppStoreConnectConfig
): Promise<void> {
  const token = await generateJWT(config);

  // Get latest build
  const builds = await getTestFlightBuilds(appId, config);
  const latestBuild = builds.find(b => b.status === 'VALID');

  if (!latestBuild) {
    throw new Error('No valid build found to submit for review. The build may still be processing.');
  }

  // Submit for TestFlight review
  const res = await fetch(
    'https://api.appstoreconnect.apple.com/v1/betaAppReviewSubmissions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: {
            build: {
              data: { type: 'builds', id: latestBuild.buildNumber }
            }
          }
        }
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Submit for review failed: ${res.status} ${text}`);
  }
}
