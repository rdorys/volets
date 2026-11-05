// Protocole BLE des boîtiers Distech Allure UNITOUCH, reconstitué depuis l'appli
// my Personify 1.9.1 (Android, assembly PCA.Model.Ble.Unitouch.dll).
// Les noms de méthodes cités en commentaire sont ceux de l'appli d'origine.

const S = '-00137e5a8eef';

export const PROFILES = {
  v2: {
    label: 'UNITOUCH V2',
    configService: '00010000-0000-0000-0000' + S,
    configBlinds: '00010003-0000-0000-0000' + S,
    liveService: '00020000-0000-0000-0000' + S,
    liveBlinds: '00020003-0000-0000-0000' + S,
    writeService: '00000000-0000-0000-0000' + S,
    writeChar: '00000004-0000-0000-0000' + S,
  },
  v1: {
    label: 'UNITOUCH V1',
    configService: '00000000-0000-0001-0100' + S,
    configBlinds: '00000000-0000-0000-0102' + S,
    liveService: '00000000-0000-0001-0200' + S,
    liveBlinds: '00000000-0000-0000-0202' + S,
    writeService: '00000000-0000-0001-0000' + S,
    writeChar: '00000000-0000-0000-0004' + S,
  },
};

// Écran nLight nTS : détecté, mais sa disposition multi-caractéristiques n'est pas gérée.
export const NTS_CONFIG_SERVICE = '00000000-0000-0020-0000' + S;
export const CRYPTO_SERVICE = '00040000-0000-0000-0000' + S;

export const ALL_SERVICES = [
  ...new Set([
    ...Object.values(PROFILES).flatMap((p) => [p.configService, p.liveService, p.writeService]),
    NTS_CONFIG_SERVICE,
    CRYPTO_SERVICE,
  ]),
];

// --- Décodage de la configuration (BaseParser / ParsingHelper / BlindConfigurationParser) ---

// BaseParser.GetVariablePayloadSize : nombre d'octets tant que le bit de poids fort est à 1.
export function varSize(b, start) {
  let n = 1;
  while (start + n - 1 < b.length && (b[start + n - 1] & 0x80) === 0x80) n++;
  return n;
}

const chunk = (b, start, len) => b.slice(start, start + Math.max(0, len));

// ParsingHelper.RemoveMsbFromVariablePayload + ToInt32 : entier par groupes de 7 bits, poids faible d'abord.
export function toUInt(c) {
  let v = 0;
  for (let i = 0; i < c.length; i++) v = (v + ((c[i] & 0x7f) << ((i * 7) & 31))) | 0;
  return v;
}

// ParsingHelper.XorIfLsbSet : le bit 0 porte le signe, seul le premier octet est décalé.
export function toSInt(c) {
  const bytes = new Uint8Array(new Int32Array([toUInt(c)]).buffer);
  const negative = (bytes[0] & 1) === 1;
  bytes[0] >>= 1;
  if (negative) for (let i = 0; i < 4; i++) bytes[i] ^= 0xff;
  return new DataView(bytes.buffer).getInt32(0, true);
}

const utf8 = (c) => new TextDecoder().decode(c);

// BlindConfigurationParser.ParseGroup
export function parseGroup(b, defaultIndex) {
  const g = { index: defaultIndex, name: '', configuration: 0, hasAuto: false, enabled: false };
  let i = 0;
  while (i < b.length) {
    let size = 0;
    switch (b[i]) {
      case 5:
        size = varSize(b, i + 1);
        g.index = toSInt(chunk(b, i + 1, size));
        break;
      case 10: {
        const s = varSize(b, i + 1);
        const len = toUInt(chunk(b, i + 1, s));
        size = s + len;
        g.name = utf8(chunk(b, i + s + 1, len - 1));
        break;
      }
      case 21:
        size = varSize(b, i + 1);
        g.configuration = toSInt(chunk(b, i + 1, size));
        break;
      case 31:
        g.hasAuto = true;
        break;
      case 39:
        g.enabled = true;
        break;
    }
    i += size + 1;
  }
  // ReadBlindsLiveDataRequest : HasRotation = BlindConfiguration != 0
  g.hasRotation = g.configuration !== 0;
  return g;
}

// BlindConfigurationParser.Parse
export function parseBlindConfig(b) {
  const groups = [];
  if (b.length > 3 && b[0] === 0x80) {
    let pos = varSize(b, 2) + 2;
    while (b.length > pos && b[pos] === 8) {
      const s = varSize(b, pos + 1);
      const len = toUInt(chunk(b, pos + 1, s));
      pos += s;
      groups.push(parseGroup(chunk(b, pos + 1, len), groups.length));
      pos += len + 1;
    }
  }
  return groups;
}

// --- Données en direct (LiveDataOffsetHelper / BlindsLiveDataExtension) ---
// Bloc de 16 octets par groupe : consigne hauteur, hauteur mesurée (%), orientation (degrés, signée),
// puis une 4e valeur égale à l'orientation + 90 sur les boîtiers observés. Les commandes écrivent
// dans cette même table : le décalage d'une commande est celui de la valeur visée.
// Le bloc global (0–15) contient les moyennes des groupes.
export const ROTATION_MIN = -90;
export const ROTATION_MAX = 90;

export const OFFSET = {
  globalLevel: 0,
  globalLevelFeedback: 4,
  level: (i) => 16 + 16 * i,
  levelFeedback: (i) => 20 + 16 * i,
  rotation: (i) => 24 + 16 * i,
};

// Les notifications peuvent ne porter que le début de la table (MTU de 23 octets par défaut) :
// on les superpose à la dernière lecture complète au lieu de la remplacer.
export function mergeLive(previous, chunk) {
  if (!previous || chunk.length >= previous.length) return chunk.slice();
  const merged = previous.slice();
  merged.set(chunk, 0);
  return merged;
}

export function readFloat(b, offset) {
  if (!b || b.length < offset + 4) return NaN;
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(offset, true);
}

// --- Commandes (BaseWriteRequest.ParseDataToBytes(short, short, float)) ---

const BLINDS_COMMAND = 0x0202;

export function blindCommand(offset, value) {
  const v = new DataView(new ArrayBuffer(8));
  v.setInt16(0, BLINDS_COMMAND, true);
  v.setInt16(2, offset, true);
  // NaN = « auto » (WriteBlindGroupAutoRequest). On reproduit le float.NaN de .NET (0xFFC00000)
  // octet pour octet ; JavaScript écrirait 0x7FC00000.
  if (Number.isNaN(value)) v.setUint32(4, 0xffc00000, true);
  else v.setFloat32(4, value, true);
  return new Uint8Array(v.buffer);
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
