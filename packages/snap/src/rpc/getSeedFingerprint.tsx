import {
  SeedFingerprint,
} from '@zcashcommunitygrants/webzjs-keys';
import { getSeed, getActiveDerivationVersion } from '../utils/getSeed';

export async function getSeedFingerprint(): Promise<string> {

  const seed = await getSeed(await getActiveDerivationVersion());

  const seedFingerprint = new SeedFingerprint(seed);

  const seedFingerprintUint8 = seedFingerprint.to_bytes();

  const seedFingerprintHexString = Array.from(seedFingerprintUint8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return seedFingerprintHexString;
}