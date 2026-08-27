// ── Demo mode ─────────────────────────────────────────────────────────────────
// Staged data for App Store screenshots. Enabled only when the app is started
// with EXPO_PUBLIC_DEMO=1, so a production build can never turn this on.
//
//   EXPO_PUBLIC_DEMO=1 npx expo run:ios --device "iPhone 17 Pro Max"
//
// The iOS Simulator has no camera, so DEMO also makes the app runnable there:
// it swaps a bundled photo in for CameraView and skips the permission gates.
//
// To use real photos, drop them into assets/demo/ under the same filenames.

import { Asset } from 'expo-asset';

export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export const DEMO_SCENES = [
  require('./assets/demo/scene-1.jpg'),
  require('./assets/demo/scene-2.jpg'),
  require('./assets/demo/scene-3.jpg'),
  require('./assets/demo/scene-4.jpg'),
  require('./assets/demo/scene-5.jpg'),
];

// Pre-filled overlay so the timestamp bar reads like real use rather than
// a row of empty placeholders.
export const DEMO_VALUES = {
  date: '08/24/2026',
  location: '1420 W Adams Blvd, Los Angeles, CA 90007',
  pm: '24-0187',
  notification: '',
  foreman: 'R. Alvarez',
  photoType: 'Progress',
};

// foreman + photoType are off by default; turn them on so the bar looks fuller.
export const DEMO_TEMPLATE = {
  date: true, location: true, pm: true,
  notification: false, foreman: true, photoType: true,
};

// Resolves the bundled images to real file:// URIs so every existing
// <Image source={{ uri }} /> and the Skia compositor work unchanged.
export async function loadDemoScenes() {
  const assets = await Asset.loadAsync(DEMO_SCENES);
  return assets.map(a => ({ uri: a.localUri ?? a.uri, width: a.width, height: a.height }));
}

const DAY = 24 * 60 * 60 * 1000;

const DEMO_PMS = [
  { pm: '24-0187', location: '1420 W Adams Blvd, Los Angeles, CA 90007', scenes: [0, 1, 2] },
  { pm: '24-0203', location: '8815 Sepulveda Eastway, Los Angeles, CA 90045', scenes: [3, 4] },
  { pm: '23-1146', location: '2600 E Olympic Blvd, Los Angeles, CA 90023', scenes: [2, 0] },
];

// Populates the folder list and photo grid, which otherwise start empty.
export function demoGroups(scenes) {
  const now = Date.now();
  const groups = {};
  DEMO_PMS.forEach((g, gi) => {
    groups[g.pm] = g.scenes.map((si, pi) => {
      const savedAt = now - gi * 3 * DAY - (g.scenes.length - pi) * DAY;
      const d = new Date(savedAt);
      return {
        uri: scenes[si].uri,
        date: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`,
        location: g.location,
        pm: g.pm,
        savedAt,
      };
    });
  });
  return groups;
}
