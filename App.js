import { useState, useRef, useEffect, useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet, Text, View, TouchableOpacity, Pressable,
  Image, Alert, TextInput, Modal, Switch,
  ScrollView, KeyboardAvoidingView, Platform, FlatList,
  Animated, PanResponder, Dimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Skia, ImageFormat, FontStyle } from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayString() {
  const n = new Date();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${m}/${d}/${n.getFullYear()}`;
}

const FIELDS = [
  { key: 'date',         label: null,       displayName: 'Date',               placeholder: 'MM/DD/YYYY',    defaultOn: true  },
  { key: 'location',     label: null,       displayName: 'Address / Location',  placeholder: 'Location',      defaultOn: true  },
  { key: 'pm',           label: 'PM#',      displayName: 'PM #',               placeholder: '---',           defaultOn: true  },
  { key: 'notification', label: 'Notif#',   displayName: 'Notification #',     placeholder: '---',           defaultOn: false },
  { key: 'foreman',      label: 'Foreman',  displayName: 'Foreman Name',       placeholder: 'Name',          defaultOn: false },
  { key: 'photoType',    label: 'Type',     displayName: 'Photo Type',         placeholder: 'e.g. Progress', defaultOn: false },
];

const DEFAULT_TEMPLATE = Object.fromEntries(FIELDS.map(f => [f.key, f.defaultOn]));

// ── PM Groups persistence ─────────────────────────────────────────────────────

const GROUPS_FILE = FileSystem.documentDirectory + 'pm_groups.json';
const PHOTOS_DIR  = FileSystem.documentDirectory + 'pm_photos/';

async function readGroups() {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(GROUPS_FILE));
  } catch {
    return {};
  }
}

async function writeGroups(groups) {
  await FileSystem.writeAsStringAsync(GROUPS_FILE, JSON.stringify(groups));
}

async function ensurePhotoDir(pm) {
  const safePm = pm.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = PHOTOS_DIR + safePm + '/';
  // intermediates:true creates the full path including pm_photos/ parent.
  // If the directory already exists the call throws — we ignore that.
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  return dir;
}

// ── Native-resolution photo compositing ───────────────────────────────────────

async function buildComposite(photo, values, template) {
  const data = await Skia.Data.fromURI(photo.uri);
  if (!data) throw new Error('Could not load photo data.');
  const img = Skia.Image.MakeImageFromEncoded(data);
  if (!img) throw new Error('Could not decode photo.');

  const imgW = img.width();
  const imgH = img.height();
  const screenW = Dimensions.get('window').width;
  const scale = imgW / screenW;

  const surface = Skia.Surface.Make(imgW, imgH);
  if (!surface) throw new Error('Could not create render surface.');
  const canvas = surface.getCanvas();

  canvas.drawImage(img, 0, 0);

  const topFields = FIELDS.filter(f => f.key !== 'location' && template[f.key]);
  const showAddr  = template.location;
  const hasTop    = topFields.length > 0;

  const fontSize = Math.round(15 * scale);
  const padTop   = Math.round(22 * scale);
  const padBot   = Math.round(30 * scale);
  const rowGap   = Math.round(6  * scale);
  const lineH    = Math.round(fontSize * 1.65);

  let contentH = 0;
  if (hasTop)             contentH += lineH;
  if (hasTop && showAddr) contentH += rowGap;
  if (showAddr)           contentH += lineH;

  const overlayH = padTop + contentH + padBot;
  const overlayY = imgH - overlayH;

  const bgPaint = Skia.Paint();
  bgPaint.setColor(Skia.Color('rgba(0,0,0,0.62)'));
  canvas.drawRect({ x: 0, y: overlayY, width: imgW, height: overlayH }, bgPaint);

  // Prefer an explicit font family known to exist on iOS/Android.
  // matchFamilyStyle with '' may return a typeface whose glyphs do not render
  // correctly via the legacy drawSimpleText path.
  const fm = Skia.FontMgr.System();
  const typeface =
    fm.matchFamilyStyle('Helvetica Neue', FontStyle.Normal) ??
    fm.matchFamilyStyle('Helvetica',      FontStyle.Normal) ??
    fm.matchFamilyStyle('Arial',          FontStyle.Normal) ??
    fm.matchFamilyStyle('Roboto',         FontStyle.Normal) ??
    fm.matchFamilyStyle('',              FontStyle.Normal);
  if (!typeface) throw new Error('No system font available for overlay.');
  const font = Skia.Font(typeface, fontSize);

  const textPaint = Skia.Paint();
  textPaint.setColor(Skia.Color('white'));

  // Use TextBlob API — more reliable than canvas.drawText (which calls the
  // deprecated SkCanvas::drawSimpleText and can silently produce no output).
  if (hasTop) {
    const parts = topFields.map(f =>
      f.label ? `${f.label} ${values[f.key] || f.placeholder}` : (values[f.key] || f.placeholder)
    );
    const text = parts.join('  |  ');
    const blob = Skia.TextBlob.MakeFromText(text, font);
    const tw   = font.measureText(text).width;
    canvas.drawTextBlob(blob, (imgW - tw) / 2, overlayY + padTop + fontSize, textPaint);
  }

  if (showAddr) {
    const text = values.location || '';
    if (text) {
      const blob = Skia.TextBlob.MakeFromText(text, font);
      const lw   = font.measureText(text).width;
      let   ly   = overlayY + padTop + fontSize;
      if (hasTop) ly += lineH + rowGap;
      canvas.drawTextBlob(blob, (imgW - lw) / 2, ly, textPaint);
    }
  }

  surface.flush();
  const snapshot = surface.makeImageSnapshot();
  if (!snapshot) throw new Error('Could not capture surface snapshot.');

  const outB64  = snapshot.encodeToBase64(ImageFormat.JPEG, 95);
  if (!outB64) throw new Error('Could not encode image.');
  const destUri = FileSystem.cacheDirectory + 'composite_' + Date.now() + '.jpg';
  await FileSystem.writeAsStringAsync(destUri, outB64, { encoding: FileSystem.EncodingType.Base64 });
  return destUri;
}

// ── Timestamp overlay ─────────────────────────────────────────────────────────

// Invisible ghost Text drives the natural content width; the real TextInput
// overlays it; a hairline View below matches that measured width.
function DynamicInput({ value, placeholder, color, borderColor, onChangeText, center = false }) {
  const [w, setW] = useState(0);
  const ghost = value || placeholder || ' ';

  return (
    <View style={{ alignItems: center ? 'center' : 'flex-start' }}>
      <View>
        {/* Ghost — invisible, provides layout width for the wrapper */}
        <Text
          style={styles.tsGhost}
          onLayout={e => setW(Math.max(e.nativeEvent.layout.width + 2, 28))}
        >
          {ghost}
        </Text>
        {/* Real input overlaid exactly on the ghost */}
        <TextInput
          style={[styles.tsInput, {
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            color, textAlign: center ? 'center' : 'left',
          }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={color}
          returnKeyType="done"
        />
      </View>
      {/* Underline sized to the ghost text width */}
      <View style={{ height: StyleSheet.hairlineWidth, width: w, backgroundColor: borderColor }} />
    </View>
  );
}

function TimestampBar({ dim, template, values, onChange, overlay = false }) {
  const topFields   = FIELDS.filter(f => f.key !== 'location' && template[f.key]);
  const showAddress = template.location;

  const color     = dim ? 'rgba(255,255,255,0.30)' : '#fff';
  const phColor   = dim ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.45)';
  const borderCol = dim ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.40)';

  return (
    <View style={[styles.tsBar, overlay && styles.tsBarOverlay, dim ? styles.tsBarDim : styles.tsBarClear]}>
      {/* Top row: date, PM#, and any other non-address fields */}
      {topFields.length > 0 && (
        <View style={styles.tsRow}>
          {topFields.map((field, i) => (
            <View key={field.key} style={styles.tsFieldGroup}>
              {i > 0 && <Text style={[styles.tsDot, { color }]}> · </Text>}
              {field.label ? <Text style={[styles.tsLabel, { color }]}>{field.label} </Text> : null}
              <DynamicInput
                value={values[field.key]}
                placeholder={field.placeholder}
                color={color}
                borderColor={borderCol}
                onChangeText={v => onChange(field.key, v)}
              />
            </View>
          ))}
        </View>
      )}
      {/* Bottom row: full address, centered */}
      {showAddress && (
        <View style={{ marginTop: 4, width: '100%' }}>
          <DynamicInput
            center
            value={values.location}
            placeholder="Address"
            color={color}
            borderColor={borderCol}
            onChangeText={v => onChange('location', v)}
          />
        </View>
      )}
    </View>
  );
}

// ── Settings modal ────────────────────────────────────────────────────────────

function SettingsModal({ visible, template, onToggle, onClose }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetOverlay}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Edit Template</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.sheetSub}>Choose which fields appear on your photos</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {FIELDS.map((field, i) => (
              <View key={field.key} style={[styles.templateRow, i === FIELDS.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={styles.templateLabel}>{field.displayName}</Text>
                <Switch
                  value={template[field.key]}
                  onValueChange={() => onToggle(field.key)}
                  trackColor={{ false: '#444', true: '#2a9' }}
                  thumbColor="#fff"
                />
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── PM Photos modal ───────────────────────────────────────────────────────────

function PMPhotosModal({ pm, photos, onBack, onDeletePhotos }) {
  const [selecting, setSelecting]   = useState(false);
  const [selected, setSelected]     = useState(new Set());
  const [sharing, setSharing]       = useState(false);
  const [previewIdx, setPreviewIdx] = useState(null);
  const reversed = useMemo(() => [...photos].reverse(), [photos]);

  // Refs so pan gesture callbacks always see current values
  const previewIdxRef = useRef(null);
  const reversedRef   = useRef(reversed);
  previewIdxRef.current = previewIdx;
  reversedRef.current   = reversed;

  const SCREEN_H = Dimensions.get('window').height;
  const dragY = useRef(new Animated.Value(0)).current;

  const backdropOpacity = dragY.interpolate({ inputRange: [0, SCREEN_H * 0.5], outputRange: [1, 0], extrapolate: 'clamp' });
  const contentScale    = dragY.interpolate({ inputRange: [0, SCREEN_H * 0.5], outputRange: [1, 0.88], extrapolate: 'clamp' });

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
    onPanResponderMove: (_, g) => {
      const vertical = Math.abs(g.dy) >= Math.abs(g.dx);
      if (vertical && g.dy > 0) dragY.setValue(g.dy * 0.88);
    },
    onPanResponderRelease: (_, g) => {
      const vertical   = Math.abs(g.dy) >= Math.abs(g.dx);
      const horizontal = !vertical;
      const idx = previewIdxRef.current;
      const max = reversedRef.current.length - 1;

      if (vertical && (g.dy > 100 || g.vy > 0.8)) {
        Animated.spring(dragY, {
          toValue: SCREEN_H,
          velocity: g.vy * 4,
          tension: 40,
          friction: 9,
          useNativeDriver: true,
        }).start(() => { setPreviewIdx(null); dragY.setValue(0); });
      } else if (horizontal && g.dx < -60 && idx < max) {
        setPreviewIdx(idx + 1);
        dragY.setValue(0);
      } else if (horizontal && g.dx > 60 && idx > 0) {
        setPreviewIdx(idx - 1);
        dragY.setValue(0);
      } else {
        Animated.spring(dragY, { toValue: 0, tension: 80, friction: 12, useNativeDriver: true }).start();
      }
    },
  })).current;

  function enterSelect()  { setSelecting(true); setSelected(new Set()); }
  function cancelSelect() { setSelecting(false); setSelected(new Set()); }

  function toggleItem(uri) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(uri) ? next.delete(uri) : next.add(uri);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(reversed.map(p => p.uri)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  async function sharePhotos(uris) {
    if (uris.length === 0) return;
    setSharing(true);
    try {
      for (const uri of uris) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `PM# ${pm}` });
      }
    } catch {
      // user cancelled or sharing failed — no alert needed
    } finally {
      setSharing(false);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    Alert.alert(
      'Delete Photos',
      `Remove ${selected.size} photo${selected.size !== 1 ? 's' : ''} from PM# ${pm}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            await onDeletePhotos(pm, [...selected]);
            cancelSelect();
          },
        },
      ],
    );
  }

  const allSelected = selected.size === reversed.length && reversed.length > 0;

  return (
    <Modal visible animationType="slide" onRequestClose={selecting ? cancelSelect : onBack}>
      <View style={styles.fullScreen}>
        {/* ── Header ── */}
        {!selecting ? (
          <View style={styles.fullHeader}>
            <TouchableOpacity onPress={onBack} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <View style={{ alignItems: 'center' }}>
              <Text style={styles.fullTitle}>PM# {pm}</Text>
              <Text style={styles.headerSub}>{photos.length} photo{photos.length !== 1 ? 's' : ''}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
              <TouchableOpacity onPress={() => sharePhotos(reversed.map(p => p.uri))} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
                <Ionicons name="share-outline" size={24} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={enterSelect} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
                <Text style={{ color: '#4a9eff', fontSize: 15, fontWeight: '600' }}>Select</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.fullHeader}>
            <TouchableOpacity onPress={cancelSelect} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={{ color: '#4a9eff', fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.headerSub}>
              {selected.size === 0 ? 'Select Photos' : `${selected.size} selected`}
            </Text>
            <TouchableOpacity onPress={allSelected ? deselectAll : selectAll} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
              <Text style={{ color: '#4a9eff', fontSize: 15, fontWeight: '600' }}>
                {allSelected ? 'Deselect All' : 'Select All'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Photo grid ── */}
        <FlatList
          data={reversed}
          keyExtractor={(_, i) => String(i)}
          numColumns={3}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.gridContent}
          renderItem={({ item, index }) => {
            const isSelected = selected.has(item.uri);
            return (
              <TouchableOpacity
                style={styles.gridCell}
                activeOpacity={0.7}
                onPress={selecting ? () => toggleItem(item.uri) : () => setPreviewIdx(index)}
              >
                <Image source={{ uri: item.uri }} style={styles.gridImg} />
                <Text style={styles.gridDate} numberOfLines={1}>{item.date}</Text>
                {selecting && (
                  <View style={styles.gridSelectOverlay}>
                    <View style={[styles.gridCheckCircle, isSelected && styles.gridCheckCircleOn]}>
                      {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                    </View>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />

        {/* ── Selection action bar ── */}
        {selecting && (
          <View style={styles.selectBar}>
            <TouchableOpacity
              style={[styles.selectBarBtn, selected.size === 0 && { opacity: 0.35 }]}
              disabled={selected.size === 0 || sharing}
              onPress={() => sharePhotos([...selected])}
            >
              <Ionicons name="share-outline" size={22} color="#fff" />
              <Text style={styles.selectBarLabel}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectBarBtn, selected.size === 0 && { opacity: 0.35 }]}
              disabled={selected.size === 0}
              onPress={deleteSelected}
            >
              <Ionicons name="trash-outline" size={22} color="#ff4444" />
              <Text style={[styles.selectBarLabel, { color: '#ff4444' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Full-screen photo preview ── */}
        {previewIdx !== null && (
          <Modal visible animationType="fade" transparent onRequestClose={() => setPreviewIdx(null)}>
            {/* Black backdrop fades as the photo slides away */}
            <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdropOpacity }]} />
            <Animated.View
              style={[styles.previewOverlay, { transform: [{ translateY: dragY }, { scale: contentScale }] }]}
              {...panResponder.panHandlers}
            >
              <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewIdx(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>
              <Image source={{ uri: reversed[previewIdx]?.uri }} style={styles.previewFull} resizeMode="contain" />
              {reversed.length > 1 && (
                <Text style={styles.previewCounter}>{previewIdx + 1} / {reversed.length}</Text>
              )}
            </Animated.View>
          </Modal>
        )}
      </View>
    </Modal>
  );
}

// ── Folders modal ─────────────────────────────────────────────────────────────

function FoldersModal({ visible, groups, onSelectPm, onClose }) {
  const pmList = Object.keys(groups).sort((a, b) => {
    return (groups[b].at(-1)?.savedAt ?? 0) - (groups[a].at(-1)?.savedAt ?? 0);
  });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.fullScreen}>
        <View style={styles.fullHeader}>
          <Text style={styles.fullTitle}>PM Groups</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        {pmList.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="folder-open-outline" size={72} color="#333" />
            <Text style={styles.emptyTitle}>No PM Groups Yet</Text>
            <Text style={styles.emptySub}>
              After taking a photo, tap "Save to PM#" to start grouping by project number.
            </Text>
          </View>
        ) : (
          <FlatList
            data={pmList}
            keyExtractor={pm => pm}
            renderItem={({ item: pm }) => {
              const photos = groups[pm];
              const last   = photos.at(-1);
              return (
                <TouchableOpacity style={styles.folderRow} onPress={() => onSelectPm(pm)}>
                  <Image source={{ uri: last.uri }} style={styles.folderThumb} />
                  <View style={styles.folderMeta}>
                    <Text style={styles.folderPm}>PM# {pm}</Text>
                    <Text style={styles.folderCount}>{photos.length} photo{photos.length !== 1 ? 's' : ''}</Text>
                    <Text style={styles.folderLoc} numberOfLines={1}>{last.location}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="#444" />
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [permission, requestPermission]           = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();
  const [photo, setPhoto]           = useState(null);
  const [facing, setFacing]         = useState('back');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [foldersVisible, setFoldersVisible]   = useState(false);
  const [selectedPm, setSelectedPm]           = useState(null);
  const [groups, setGroups]         = useState({});

  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [values, setValues]     = useState(() => ({
    date: todayString(), location: 'Locating…',
    pm: '', notification: '', foreman: '', photoType: '',
  }));

  const cameraRef = useRef(null);

  const [focusPt, setFocusPt]           = useState(null);
  const [autoFocusMode, setAutoFocusMode] = useState('off');
  const focusRingOpacity = useRef(new Animated.Value(0)).current;
  const focusRingScale   = useRef(new Animated.Value(1)).current;
  const focusTimer       = useRef(null);

  useEffect(() => { readGroups().then(setGroups); }, []);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setValues(v => ({ ...v, location: 'No location' })); return; }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const geo = await Location.reverseGeocodeAsync(loc.coords);
      let text = `${loc.coords.latitude.toFixed(4)}°, ${loc.coords.longitude.toFixed(4)}°`;
      if (geo.length > 0) {
        const { streetNumber, street, city, region, postalCode } = geo[0];
        const parts = [
          [streetNumber, street].filter(Boolean).join(' '),
          city,
          [region, postalCode].filter(Boolean).join(' '),
        ].filter(Boolean);
        if (parts.length > 0) text = parts.join(', ');
      }
      setValues(v => ({ ...v, location: text }));
    })();
  }, []);

  function updateValue(key, val)  { setValues(v => ({ ...v, [key]: val })); }
  function toggleTemplate(key)    { setTemplate(t => ({ ...t, [key]: !t[key] })); }

  function handleCameraTap(e) {
    const { pageX, pageY } = e.nativeEvent;
    if (focusTimer.current) clearTimeout(focusTimer.current);
    setFocusPt({ x: pageX, y: pageY });
    setAutoFocusMode('on');
    focusTimer.current = setTimeout(() => setAutoFocusMode('off'), 800);
    focusRingOpacity.stopAnimation();
    focusRingScale.stopAnimation();
    focusRingOpacity.setValue(1);
    focusRingScale.setValue(1.3);
    Animated.parallel([
      Animated.timing(focusRingScale, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(700),
        Animated.timing(focusRingOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]),
    ]).start(({ finished }) => { if (finished) setFocusPt(null); });
  }

  if (!permission) return <View style={styles.outer} />;

  if (!permission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.permText}>Camera access is required to take jobsite photos.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  async function takePicture() {
    if (!cameraRef.current) return;
    const result = await cameraRef.current.takePictureAsync({ quality: 1 });
    console.log('[takePicture]', result.width, 'x', result.height);
    setPhoto({ uri: result.uri, width: result.width, height: result.height });
  }

  async function saveToRoll() {
    if (!mediaPermission?.granted) {
      const res = await requestMediaPermission();
      if (!res.granted) { Alert.alert('Permission needed', 'Allow photo library access to save.'); return; }
    }
    try {
      const uri = await buildComposite(photo, values, template);
      await MediaLibrary.createAssetAsync(uri);
      Alert.alert('Saved', 'Photo saved to your camera roll.');
      setPhoto(null);
    } catch (e) {
      Alert.alert('Error', `Could not save photo.\n\n${e?.message ?? e}`);
    }
  }

  async function saveToPm() {
    const pm = values.pm.trim();
    if (!pm) {
      Alert.alert('PM# Required', 'Enter a PM# in the overlay before saving to a PM group.');
      return;
    }
    try {
      const uri  = await buildComposite(photo, values, template);
      const dir  = await ensurePhotoDir(pm);
      const dest = dir + Date.now() + '.jpg';
      await FileSystem.copyAsync({ from: uri, to: dest });

      const entry   = { uri: dest, date: values.date, location: values.location, pm, savedAt: Date.now() };
      const updated = { ...groups, [pm]: [...(groups[pm] ?? []), entry] };
      setGroups(updated);
      await writeGroups(updated);

      Alert.alert('Saved', `Photo added to PM# ${pm}.`);
      setPhoto(null);
    } catch (e) {
      Alert.alert('Error', `Could not save photo to PM group.\n\n${e?.message ?? e}`);
    }
  }

  function openPmFolder(pm) { setFoldersVisible(false); setSelectedPm(pm); }
  function closePmFolder()  { setSelectedPm(null);     setFoldersVisible(true); }

  async function deletePhotosFromPm(pm, urisToDelete) {
    const uriSet  = new Set(urisToDelete);
    const kept    = (groups[pm] ?? []).filter(p => !uriSet.has(p.uri));
    const updated = { ...groups, [pm]: kept };
    if (kept.length === 0) delete updated[pm];
    setGroups(updated);
    await writeGroups(updated);
    if (kept.length === 0) closePmFolder();
    for (const uri of urisToDelete) {
      try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { /* ignore */ }
    }
  }

  const tsProps  = { template, values, onChange: updateValue };
  const pmCount  = Object.keys(groups).length;

  // ── Photo preview ─────────────────────────────────────────────────────────
  if (photo) {
    return (
      <View style={styles.outer}>
        <View style={styles.shot}>
          <Image source={{ uri: photo.uri }} style={styles.previewImg} />
          <TimestampBar overlay dim={false} {...tsProps} />
        </View>

        <View style={styles.actionArea}>
          {/* Row 1: Retake + Camera Roll */}
          <View style={styles.btnRow}>
            <TouchableOpacity style={[styles.btn, { flex: 1 }]} onPress={() => setPhoto(null)}>
              <Text style={styles.btnText}>Retake</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.saveBtn, { flex: 1 }]} onPress={saveToRoll}>
              <Text style={styles.btnText}>Camera Roll</Text>
            </TouchableOpacity>
          </View>

          {/* Row 2: Save to PM# (full width) */}
          <TouchableOpacity style={[styles.btn, styles.pmSaveBtn, styles.btnFull]} onPress={saveToPm}>
            <Ionicons name="folder-open-outline" size={18} color="#fff" />
            <Text style={[styles.btnText, { marginLeft: 8 }]}>
              {values.pm ? `Save to PM# ${values.pm}` : 'Save to PM#'}
            </Text>
          </TouchableOpacity>
        </View>

        <StatusBar style="light" />
      </View>
    );
  }

  // ── Camera viewfinder ─────────────────────────────────────────────────────
  return (
    <View style={styles.outer}>
      <View style={styles.camera}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} pictureSize="Photo" enableTorch={false} zoom={0} autofocus={autoFocusMode} />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          {/* Top bar — folder icon top-left */}
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.iconBtn} onPress={() => setFoldersVisible(true)}>
              <Ionicons name="folder-open-outline" size={24} color="#fff" />
              {pmCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{pmCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          <Pressable style={{ flex: 1 }} onPress={handleCameraTap} />

          <View style={styles.controls}>
            <TouchableOpacity style={styles.sideBtn} onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')}>
              <Ionicons name="camera-reverse-outline" size={28} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.shutter} onPress={takePicture} />
            <TouchableOpacity style={styles.sideBtn} onPress={() => setSettingsVisible(true)}>
              <Ionicons name="settings-outline" size={26} color="#fff" />
            </TouchableOpacity>
          </View>

          <TimestampBar dim={true} {...tsProps} />
        </KeyboardAvoidingView>

        {focusPt && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: focusPt.y - 35,
              left: focusPt.x - 35,
              width: 70,
              height: 70,
              borderRadius: 35,
              borderWidth: 1.5,
              borderColor: 'rgba(220,220,220,0.9)',
              opacity: focusRingOpacity,
              transform: [{ scale: focusRingScale }],
            }}
          />
        )}
      </View>

      <SettingsModal visible={settingsVisible} template={template} onToggle={toggleTemplate} onClose={() => setSettingsVisible(false)} />
      <FoldersModal  visible={foldersVisible}  groups={groups} onSelectPm={openPmFolder} onClose={() => setFoldersVisible(false)} />
      {selectedPm && <PMPhotosModal pm={selectedPm} photos={groups[selectedPm] ?? []} onBack={closePmFolder} onDeletePhotos={deletePhotosFromPm} />}

      <StatusBar style="light" />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  outer:    { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  camera:   { flex: 1 },

  // Camera top bar
  topBar:  { paddingTop: 58, paddingLeft: 16, paddingBottom: 4 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.40)', borderRadius: 22 },
  badge:     { position: 'absolute', top: 0, right: 0, backgroundColor: '#2a9', borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Camera controls
  controls: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingHorizontal: 24, paddingVertical: 16 },
  shutter:  { width: 72, height: 72, borderRadius: 36, backgroundColor: '#fff', borderWidth: 4, borderColor: '#ddd' },
  sideBtn:  { width: 50, height: 50, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.40)', borderRadius: 25 },

  // Timestamp bar
  tsBar:        { width: '100%', paddingTop: 22, paddingBottom: 30, paddingLeft: 20, paddingRight: 14 },
  tsBarOverlay: { position: 'absolute', bottom: 0 },
  tsBarDim:     { backgroundColor: 'rgba(0,0,0,0.18)' },
  tsBarClear:   { backgroundColor: 'rgba(0,0,0,0.62)' },
  tsRow:        { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  tsFieldGroup: { flexDirection: 'row', alignItems: 'center' },
  tsLabel:  { fontSize: 15, fontWeight: '600' },
  tsDot:    { fontSize: 15 },
  tsGhost:  { fontSize: 15, fontWeight: '500', paddingVertical: 1, opacity: 0 },
  tsInput:  { fontSize: 15, fontWeight: '500', paddingVertical: 1 },

  // Photo preview
  shot:       { flex: 1, width: '100%', backgroundColor: 'rgba(0,0,0,0.62)' },
  previewImg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, resizeMode: 'cover' },

  // Preview action area
  actionArea: { backgroundColor: '#111', paddingTop: 16, paddingBottom: 36, paddingHorizontal: 16, gap: 10 },
  btnRow:     { flexDirection: 'row', gap: 10 },
  btnFull:    { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },

  // Buttons
  btn:       { paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#333', borderRadius: 8, alignItems: 'center' },
  saveBtn:   { backgroundColor: '#2a9' },
  pmSaveBtn: { backgroundColor: '#1a5faa' },
  btnText:   { color: '#fff', fontSize: 15, fontWeight: '600' },
  permText:  { color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 20, paddingHorizontal: 30 },

  // Settings bottom sheet
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet:        { backgroundColor: '#1c1c1e', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 22, paddingBottom: 44, paddingHorizontal: 24, maxHeight: '70%' },
  sheetHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  sheetTitle:   { color: '#fff', fontSize: 18, fontWeight: '700' },
  sheetSub:     { color: '#888', fontSize: 13, marginBottom: 18 },
  templateRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2e2e2e' },
  templateLabel: { color: '#fff', fontSize: 16 },

  // Full-screen modals
  fullScreen: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 60 },
  fullHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  fullTitle:  { color: '#fff', fontSize: 20, fontWeight: '700' },
  headerSub:  { color: '#666', fontSize: 14 },

  // Empty state
  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 12 },
  emptyTitle: { color: '#fff', fontSize: 20, fontWeight: '600' },
  emptySub:   { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 20 },

  // Folder list rows
  folderRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  folderThumb: { width: 60, height: 60, borderRadius: 8, backgroundColor: '#222' },
  folderMeta:  { flex: 1, marginLeft: 14, gap: 3 },
  folderPm:    { color: '#fff', fontSize: 17, fontWeight: '600' },
  folderCount: { color: '#888', fontSize: 13 },
  folderLoc:   { color: '#555', fontSize: 12 },

  // Photo grid
  gridContent: { padding: 12 },
  gridRow:     { gap: 4, marginBottom: 4 },
  gridCell:    { flex: 1, aspectRatio: 1, backgroundColor: '#1a1a1a', borderRadius: 6, overflow: 'hidden' },
  gridImg:     { width: '100%', height: '100%', resizeMode: 'cover' },
  gridDate:    { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', color: '#ccc', fontSize: 9, paddingVertical: 2, textAlign: 'center' },
  gridSelectOverlay: { position: 'absolute', top: 6, right: 6 },
  gridCheckCircle:   { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center' },
  gridCheckCircleOn: { backgroundColor: '#4a9eff', borderColor: '#4a9eff' },

  // Full-screen photo preview
  previewOverlay:  { flex: 1, justifyContent: 'center' },
  previewClose:    { position: 'absolute', top: 56, right: 20, zIndex: 10 },
  previewFull:     { width: '100%', height: '80%' },
  previewCounter:  { position: 'absolute', bottom: 48, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 13 },

  // Selection action bar
  selectBar:      { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14, paddingBottom: 32, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#222', backgroundColor: '#111' },
  selectBarBtn:   { alignItems: 'center', gap: 4, paddingHorizontal: 32 },
  selectBarLabel: { color: '#fff', fontSize: 12 },
});
