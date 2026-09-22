/* eslint-disable max-lines -- 帧契约（credential 识别 / 栅格信封 / exact-raster 门 / 模型内容
   证明）单一事实源：常量与谓词和官方 @zcode/zcode-cua 0.6.3 逐字对齐（契约来源：
   官方 CLI bundle zcode.cjs 内联的 frame-contract/constants.js + credential.js +
   raster-envelope.js + model-content.js，及 node-repl-host server.js 内联副本），拆分会把
   「image_ref 权威块」的识别规则分散到多处，伪造面就会出现第二套判定。 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 常量（constants.js，官方原值）
// ---------------------------------------------------------------------------
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

// exact-raster 门拒绝时随 _meta 下发的诊断键；消费方（call-runner）据此还原拒绝原因。
const OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY = "zcode.cua/frame-integrity-rejections-v1";

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

// credential 扫描窗口：受保护上下文可见上限 256 KiB + 单条 credential JSON 上限 1 KiB。
// 嵌入扫描（scanJsonObjectCandidates）只看这个窗口，超窗直接判 overflow 而不是截断。
const PROTECTED_CONTEXT_MAX_VISIBLE_CHARS = 256 * 1024;
const CREDENTIAL_MAX_JSON_CHARS = 1024;
const CREDENTIAL_SCAN_MAX_CHARS = PROTECTED_CONTEXT_MAX_VISIBLE_CHARS + CREDENTIAL_MAX_JSON_CHARS;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

// ---------------------------------------------------------------------------
// credential.js —— image_ref 权威文本识别
// ---------------------------------------------------------------------------

// 整块文本恰为一个官方 image_ref JSON 时才认定（frame_id 绑定像素坐标，是精确栅格
// 契约的签发载体；宽松匹配会让第三方文本冒充权威块）。
export function isOfficialCuaImageRefText(text) {
  return parseFrameImageRefTextLocal(text) !== undefined;
}

function parseFrameImageRefTextLocal(text) {
  if (text.length === 0 || text.length > 1024) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !isRecord(parsed.image_ref)) {
    return undefined;
  }
  const imageRef = parsed.image_ref;
  if (
    !(
      Object.keys(imageRef).sort().join(",") === "actionable,frame_id,height,width" &&
      typeof imageRef.frame_id === "string" &&
      imageRef.frame_id.length > 0 &&
      Number.isInteger(imageRef.width) &&
      imageRef.width > 0 &&
      Number.isInteger(imageRef.height) &&
      imageRef.height > 0 &&
      imageRef.actionable === true
    )
  ) {
    return undefined;
  }
  return { frameId: imageRef.frame_id, width: imageRef.width, height: imageRef.height };
}

// 在长文本里扫描嵌入的 JSON 对象候选：花括号配对 + 字符串跳过，单候选 ≤1 KiB、
// 总候选 ≤2048，超出返回 "overflow"（绝不截断后误判 "none"）。
function scanJsonObjectCandidates(text, predicate) {
  const limit = Math.min(text.length, CREDENTIAL_SCAN_MAX_CHARS);
  const stack = [];
  let candidateCount = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < limit; index += 1) {
    const char = text[index];
    if (inString) {
      if (!escaped && char === '"') inString = false;
      escaped = !escaped && char === "\\";
      if (char !== "\\") escaped = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push(index);
      continue;
    }
    if (char !== "}" || stack.length === 0) continue;
    const start = stack.pop();
    if (index + 1 - start > CREDENTIAL_MAX_JSON_CHARS) continue;
    candidateCount += 1;
    if (candidateCount > 2048) return "overflow";
    if (predicate(text.slice(start, index + 1))) return "found";
  }
  return text.length > CREDENTIAL_SCAN_MAX_CHARS ? "overflow" : "none";
}

// 凭据检测（宽松一档）：整块是权威文本，或长文本里嵌着任何权威形状的 JSON 对象。
// 用途是媒体不可用投影——image 块送不出去时，紧随的 image_ref 凭据也必须一起撤下，
// 否则模型拿着坐标权威却没有栅格。
export function containsOfficialCuaImageRefCredentialText(text) {
  return isOfficialCuaImageRefText(text)
    ? true
    : scanJsonObjectCandidates(text, isOfficialCuaImageRefText) !== "none";
}

// 结构化值解析（比整块判定多一层尺寸上限：单边 ≤4096、像素总数 ≤16M，防伪造天文书）。
function parseOfficialCuaImageRefValue(value) {
  if (!isRecord(value) || !("image_ref" in value)) return undefined;
  if (Object.keys(value).length !== 1 || !isRecord(value.image_ref)) return null;
  const ref = value.image_ref;
  if (
    Object.keys(ref).sort().join(",") !== "actionable,frame_id,height,width" ||
    typeof ref.frame_id !== "string" ||
    ref.frame_id.length === 0 ||
    !Number.isInteger(ref.width) ||
    ref.width <= 0 ||
    ref.width > 4096 ||
    !Number.isInteger(ref.height) ||
    ref.height <= 0 ||
    ref.height > 4096 ||
    ref.width * ref.height > 16777216 ||
    ref.actionable !== true
  ) {
    return null;
  }
  return { frameId: ref.frame_id, width: ref.width, height: ref.height };
}

// 超长文本（>1 KiB）不再 JSON.parse：只探测「顶层第一个键恰为 image_ref」的形状。
// 命中 → null（形状对但字段超限，视为畸形凭据）；未命中 → undefined（不是凭据）。
function hasTopLevelJsonKey(text, key) {
  let cursor = 0;
  for (; /\s/u.test(text[cursor] ?? ""); ) cursor += 1;
  if (text[cursor] !== "{") return false;
  cursor += 1;
  let depth = 1;
  let expectKey = true;
  for (; cursor < text.length && depth > 0; ) {
    const char = text[cursor];
    if (char === '"') {
      const start = cursor;
      cursor += 1;
      let escaped = false;
      for (; cursor < text.length; ) {
        const inner = text[cursor];
        if (!escaped && inner === '"') break;
        escaped = !escaped && inner === "\\";
        if (inner !== "\\") escaped = false;
        cursor += 1;
      }
      if (cursor >= text.length) return false;
      if (depth === 1 && expectKey) {
        let parsedKey;
        try {
          parsedKey = JSON.parse(text.slice(start, cursor + 1));
        } catch {
          return false;
        }
        let after = cursor + 1;
        for (; /\s/u.test(text[after] ?? ""); ) after += 1;
        if (text[after] === ":" && parsedKey === key) return true;
      }
      cursor += 1;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (depth === 1 && char === ":") expectKey = false;
    else if (depth === 1 && char === ",") expectKey = true;
    cursor += 1;
  }
  return false;
}

// 输入是 MCP 内容块：文本块解析出权威 image_ref；畸形返回 null，非文本/非 JSON 返回 undefined。
export function parseOfficialCuaImageRef(block) {
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  if (block.text.length > CREDENTIAL_MAX_JSON_CHARS) {
    return hasTopLevelJsonKey(block.text, "image_ref") ? null : undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    return undefined;
  }
  return parseOfficialCuaImageRefValue(parsed);
}

// 深度遍历任意结构化值（structuredContent 等）：字符串走凭据检测，对象带裸 image_ref
// 键的直接按形状判定。同引用环用 seen 集合防死循环。
export function containsImageRefAuthority(value) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string") {
      if (containsOfficialCuaImageRefCredentialText(entry)) return true;
      continue;
    }
    if (typeof entry !== "object" || entry === null || seen.has(entry)) continue;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) pending.push(item);
      continue;
    }
    if (Object.hasOwn(entry, "image_ref")) {
      const parsed = parseOfficialCuaImageRefValue({ image_ref: entry.image_ref });
      if (parsed != null) return true;
    }
    for (const item of Object.values(entry)) pending.push(item);
  }
  return false;
}

// ---------------------------------------------------------------------------
// raster-envelope.js —— PNG/JPEG 头部信封（尺寸 + EXIF orientation）
// ---------------------------------------------------------------------------

// 只读栅格头部，不解码像素：给 exact-raster 门比对 image_ref 尺寸/媒体类型用。
// EXIF orientation 只允许出现且为 1（规范朝向）；出现多个互相矛盾的朝向则拒绝。
export function readRasterEnvelopeIdentity(bytes) {
  const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.subarray(0, pngMagic.length).equals(pngMagic)) {
    return readCompletePngEnvelope(bytes);
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[bytes.length - 2] !== 255 ||
    bytes[bytes.length - 1] !== 217
  ) {
    return undefined;
  }
  const sofMarkers = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
  let cursor = 2;
  let height;
  let width;
  const orientations = new Set();
  for (; cursor < bytes.length; ) {
    for (; cursor < bytes.length && bytes[cursor] !== 255; ) cursor += 1;
    for (; cursor < bytes.length && bytes[cursor] === 255; ) cursor += 1;
    if (cursor >= bytes.length) return undefined;
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 217) return undefined;
    if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
    if (cursor + 2 > bytes.length) return undefined;
    const segmentLength = bytes.readUInt16BE(cursor);
    if (segmentLength < 2 || cursor + segmentLength > bytes.length) return undefined;
    if (sofMarkers.has(marker)) {
      if (segmentLength < 7) return undefined;
      const segmentHeight = bytes.readUInt16BE(cursor + 3);
      const segmentWidth = bytes.readUInt16BE(cursor + 5);
      if (segmentHeight <= 0 || segmentWidth <= 0 || height !== undefined) return undefined;
      height = segmentHeight;
      width = segmentWidth;
    }
    if (marker === 225) {
      const orientation = readJpegExifOrientation(
        bytes.subarray(cursor + 2, cursor + segmentLength),
      );
      if (orientation === null) return undefined;
      if (orientation !== undefined) orientations.add(orientation);
    }
    if (marker === 218) {
      return segmentLength < 2 ||
        cursor + segmentLength >= bytes.length - 2 ||
        height === undefined ||
        width === undefined ||
        orientations.size > 1
        ? undefined
        : {
            mimeType: "image/jpeg",
            width,
            height,
            orientation: orientations.values().next().value,
          };
    }
    cursor += segmentLength;
  }
  return undefined;
}

function readCompletePngEnvelope(bytes) {
  let cursor = 8;
  let width = 0;
  let height = 0;
  let chunkCount = 0;
  let hasIdat = false;
  const orientations = new Set();
  for (; cursor + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(cursor);
    const end = cursor + 12 + length;
    if (end > bytes.length) return undefined;
    const type = bytes.subarray(cursor + 4, cursor + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) return undefined;
    if (chunkCount === 0) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = bytes.readUInt32BE(cursor + 8);
      height = bytes.readUInt32BE(cursor + 12);
      if (width <= 0 || height <= 0) return undefined;
    } else if (type === "IHDR") {
      return undefined;
    }
    if (type === "eXIf") {
      const orientation = readTiffOrientation(bytes.subarray(cursor + 8, cursor + 8 + length));
      if (orientation === null) return undefined;
      if (orientation !== undefined) orientations.add(orientation);
    }
    if (type === "IDAT") hasIdat = true;
    if (type === "IEND") {
      return length === 0 && hasIdat && end === bytes.length && orientations.size <= 1
        ? {
            mimeType: "image/png",
            width,
            height,
            orientation: orientations.values().next().value,
          }
        : undefined;
    }
    cursor = end;
    chunkCount += 1;
  }
  return undefined;
}

function readJpegExifOrientation(segment) {
  if (segment.length < 6 || !segment.subarray(0, 6).equals(Buffer.from("Exif\0\0")))
    return undefined;
  return readTiffOrientation(segment.subarray(6));
}

function readTiffOrientation(bytes) {
  if (bytes.length < 8) return null;
  const byteOrder = bytes.subarray(0, 2).toString("ascii");
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return null;
  const readUInt16 = (offset) =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const readUInt32 = (offset) =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (readUInt16(2) !== 42) return null;
  const ifdOffset = readUInt32(4);
  if (ifdOffset > bytes.length - 2) return null;
  const entryCount = readUInt16(ifdOffset);
  if (entryCount > 256 || ifdOffset + 2 + entryCount * 12 > bytes.length) return null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (readUInt16(entry) !== 274) continue;
    if (readUInt16(entry + 2) !== 3 || readUInt32(entry + 4) !== 1) return null;
    const value = readUInt16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// model-content.js —— exact-raster 门（preserve）与模型内容证明（attest）
// ---------------------------------------------------------------------------

// exact-raster 门：producer 签发的帧必须「图片 + 紧邻 image_ref」原子成对、恰好一张、
// 尺寸/媒体类型/字节与引用一致、能被宿主图片处理器完整解码，且 _meta 里的 producer
// integrity 元数据与最终栅格逐字段匹配。任一不满足 → 整帧拒绝（fail-closed），
// 换成拒绝文案；绝不降级放行一张「可能被改写」的栅格（frame_id 绑定像素坐标契约）。
export async function preserveOfficialCuaFrameResult(result, options = {}) {
  const rejectedReasons = [];
  const observedFrameIds = new Set();
  const parsedReferences = result.content.map(parseOfficialCuaImageRef);
  const imageCount = result.content.filter((block) => block.type === "image").length;
  if (containsImageRefAuthority(result.structuredContent)) {
    rejectedReasons.push("structuredContent contains an unpaired image_ref authority");
  }
  if (imageCount > 1) {
    rejectedReasons.push(
      `result contains ${imageCount} images; official CUA allows exactly one final raster per result`,
    );
  }
  await inspectContentBlocks({
    imageProcessorPort: options.imageProcessorPort,
    parsedReferences,
    rejectedReasons,
    result,
    signal: options.signal,
    frameIds: observedFrameIds,
  });
  if (imageCount === 1) {
    const integrityFailure = validateProducerFrameIntegrity(result, parsedReferences);
    if (integrityFailure) rejectedReasons.push(integrityFailure);
  }
  if (rejectedReasons.length === 0) return result;

  const frameIds = new Set();
  for (const reference of parsedReferences) reference?.frameId && frameIds.add(reference.frameId);
  for (const frameId of observedFrameIds) frameIds.add(frameId);
  const redactedReasons = redactFrameIds(rejectedReasons, frameIds);
  return {
    content: [
      {
        type: "text",
        text: `Official CUA image rejected by the exact-raster integrity gate. No raster authority or local artifact path was exposed; capture a new image and retry. Cause: ${redactedReasons.join("; ")}.`,
      },
    ],
    isError: true,
    _meta: { [OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY]: [...redactedReasons] },
  };
}

// 拒绝文案不能把 frame_id 再漏给模型（它已经失去权威），统一替换为 "the frame"。
function redactFrameIds(reasons, frameIds) {
  const ids = [...new Set(frameIds)]
    .filter((id) => id.length > 0)
    .sort((a, b) => b.length - a.length);
  return reasons.map((reason) => {
    let redacted = reason;
    for (const id of ids) {
      redacted = redacted.replaceAll(`frame ${id}`, "the frame").replaceAll(id, "the frame");
    }
    return redacted
      .replaceAll(/\bframe\s+frame-[0-9a-z]+\b/giu, "the frame")
      .replaceAll(/\bframe-[0-9a-z]+\b/giu, "the frame");
  });
}

async function inspectContentBlocks(state) {
  for (const [index, block] of state.result.content.entries()) {
    const reference = state.parsedReferences[index];
    if (reference !== undefined) {
      inspectReferenceBlock(state.frameIds, state.rejectedReasons, reference, index, state.result);
    }
    if (block.type !== "image") continue;
    const adjacent = state.parsedReferences[index + 1];
    if (!adjacent || adjacent === null) {
      state.rejectedReasons.push("image is missing a valid adjacent image_ref");
      continue;
    }
    const failure = await inspectImageBlock({
      block,
      imageProcessorPort: state.imageProcessorPort,
      reference: adjacent,
      signal: state.signal,
    });
    if (failure) state.rejectedReasons.push(failure);
  }
}

function inspectReferenceBlock(frameIds, rejectedReasons, reference, index, result) {
  if (reference === null) {
    rejectedReasons.push("image_ref is malformed or contains unsupported fields");
    return;
  }
  if (frameIds.has(reference.frameId)) {
    rejectedReasons.push(`frame ${reference.frameId} is duplicated in one result`);
  }
  frameIds.add(reference.frameId);
  if (result.content[index - 1]?.type !== "image") {
    rejectedReasons.push(`frame ${reference.frameId} is not immediately preceded by its image`);
  }
}

async function inspectImageBlock(state) {
  const data = typeof state.block.data === "string" ? state.block.data : undefined;
  const mimeType = typeof state.block.mimeType === "string" ? state.block.mimeType : undefined;
  if (!data || !mimeType?.startsWith("image/") || data.startsWith("data:")) {
    return `frame ${state.reference.frameId} has invalid image bytes or media type`;
  }
  if (data.length > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES) {
    return `frame ${state.reference.frameId} is ${formatByteSize(data.length)}, exceeding the immutable inline limit ${formatByteSize(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES)}`;
  }
  const decoded = decodeCanonicalBase64(data);
  if (!decoded) return `frame ${state.reference.frameId} has invalid image bytes or media type`;
  const envelope = readRasterEnvelopeIdentity(decoded);
  if (
    !envelope ||
    envelope.mimeType !== mimeType ||
    envelope.width !== state.reference.width ||
    envelope.height !== state.reference.height
  ) {
    return `frame ${state.reference.frameId} image header does not match image_ref dimensions/media type`;
  }
  if (envelope.orientation !== undefined && envelope.orientation !== 1) {
    return `frame ${state.reference.frameId} carries a non-canonical EXIF orientation`;
  }
  const decodeFailure = await validateFullyDecodedRaster({
    data: decoded,
    imageProcessorPort: state.imageProcessorPort,
    mimeType,
    reference: state.reference,
    signal: state.signal,
  });
  return decodeFailure ? `frame ${state.reference.frameId} ${decodeFailure}` : undefined;
}

function validateProducerFrameIntegrity(result, parsedReferences) {
  const content = result.content;
  const imageIndex = content.findIndex((block) => block.type === "image");
  if (imageIndex < 0 || imageIndex > content.length - 2) {
    return "producer frame integrity cannot bind an unpaired image";
  }
  const reference = parsedReferences[imageIndex + 1];
  const image = content[imageIndex];
  if (!reference || !image || image.type !== "image") {
    return "producer frame integrity cannot bind an invalid image pair";
  }
  const meta = result._meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  if (!isRecord(meta)) return "producer frame integrity metadata is missing";
  if (Object.keys(meta).sort().join(",") !== "frame_id,height,media_type,sha256,version,width") {
    return "producer frame integrity metadata has unsupported fields";
  }
  const data = typeof image.data === "string" ? image.data : undefined;
  const decoded = data ? decodeCanonicalBase64(data) : undefined;
  const mimeType = typeof image.mimeType === "string" ? image.mimeType : undefined;
  if (!decoded || !mimeType) return "producer frame integrity image bytes are invalid";
  const sha256 = createHash("sha256").update(decoded).digest("hex");
  return meta.version === 1 &&
    meta.frame_id === reference.frameId &&
    meta.width === reference.width &&
    meta.height === reference.height &&
    meta.media_type === mimeType &&
    meta.sha256 === sha256
    ? undefined
    : "producer frame integrity metadata does not match the final raster";
}

async function validateFullyDecodedRaster(state) {
  if (!state.imageProcessorPort) return "cannot be fully decoded by the host image processor";
  try {
    const prepared = await state.imageProcessorPort.resizeToFit(
      {
        data: state.data,
        maxDimension: Math.max(state.reference.width, state.reference.height),
        mediaType: state.mimeType,
      },
      { signal: state.signal },
    );
    const bytesUnchanged = Buffer.from(prepared.data).equals(state.data);
    return prepared.resized === false &&
      bytesUnchanged &&
      prepared.mediaType === state.mimeType &&
      prepared.originalWidth === state.reference.width &&
      prepared.originalHeight === state.reference.height &&
      prepared.width === state.reference.width &&
      prepared.height === state.reference.height
      ? undefined
      : "decoded pixels do not match the immutable image_ref";
  } catch (error) {
    if (state.signal?.aborted) throw error;
    return "cannot be fully decoded by the host image processor";
  }
}

// 规范 base64：长度对齐 4、字符集规范、round-trip 一致（拒绝带空白/URL 变体的载荷）。
function decodeCanonicalBase64(text) {
  if (
    text.length === 0 ||
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(text, "base64");
  return decoded.length > 0 && decoded.toString("base64") === text ? decoded : undefined;
}

// ---------------------------------------------------------------------------
// 模型内容证明：canonical pair 定位 + 最终栅格 attestation
// ---------------------------------------------------------------------------

// 最终门（call-runner 在 modelContentProtection 命中时调用）：内容里恰好一张图、
// 恰好一个权威 image_ref、data URL 为规范且有界（≤200 KiB）时，返回带 sha256 的证明；
// 否则 undefined，由调用方 fail-closed。
export function attestOfficialCuaFrameContent(content, expectedKind) {
  if (expectedKind !== undefined && expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION) {
    return undefined;
  }
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  const reference = parseOfficialCuaImageRef(pair.imageRef);
  const decoded = decodeCanonicalBoundedImageDataUrl(pair.image);
  if (!reference || !decoded) return undefined;
  return {
    kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    frameId: reference.frameId,
    mediaType: pair.image.mediaType,
    width: reference.width,
    height: reference.height,
    sha256: createHash("sha256").update(decoded).digest("hex"),
  };
}

// canonical pair：内容数组里恰好一张 image 块、其后紧跟唯一的权威 image_ref 文本块。
// 输入是 CLI 内部媒体内容块（image 带 mediaType + dataUrl）。
export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  const images = content
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.type === "image");
  if (images.length !== 1) return undefined;
  const image = images[0];
  const imageRefIndex = image.index + 1;
  const imageRef = content[imageRefIndex];
  if (
    !(
      imageRef?.type !== "text" ||
      typeof imageRef.text !== "string" ||
      !isOfficialCuaImageRefText(imageRef.text) ||
      content.filter(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          isOfficialCuaImageRefText(block.text),
      ).length !== 1
    ) &&
    typeof image.block.mediaType === "string" &&
    image.block.mediaType.startsWith("image/") &&
    hasCanonicalBoundedImageDataUrl(image.block)
  ) {
    return { image: image.block, imageIndex: image.index, imageRef, imageRefIndex };
  }
  return undefined;
}

function hasCanonicalBoundedImageDataUrl(block) {
  return decodeCanonicalBoundedImageDataUrl(block) !== undefined;
}

function decodeCanonicalBoundedImageDataUrl(block) {
  const prefix = `data:${block.mediaType};base64,`;
  if (!block.dataUrl.startsWith(prefix)) return undefined;
  const payload = block.dataUrl.slice(prefix.length);
  if (
    payload.length === 0 ||
    payload.length > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES ||
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(payload, "base64");
  return decoded.length > 0 && decoded.toString("base64") === payload ? decoded : undefined;
}
