export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY: string;
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION: string;
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES: number;

export declare function isOfficialCuaImageRefText(text: string): boolean;
export declare function containsOfficialCuaImageRefCredentialText(text: string): boolean;
export declare function containsImageRefAuthority(value: unknown): boolean;

export interface OfficialCuaImageRef {
  frameId: string;
  width: number;
  height: number;
}

/** 输入是 MCP 内容块；畸形引用返回 null，非文本/非 JSON 返回 undefined。 */
export declare function parseOfficialCuaImageRef(
  block: { type?: unknown; text?: unknown } | null | undefined,
): OfficialCuaImageRef | null | undefined;

export interface RasterEnvelopeIdentity {
  mimeType: string;
  width: number;
  height: number;
  orientation?: number;
}

/** 只读 PNG/JPEG 头部信封（尺寸 + EXIF orientation），不解码像素。 */
export declare function readRasterEnvelopeIdentity(
  input: Buffer | Uint8Array,
): RasterEnvelopeIdentity | undefined;

export declare function preserveOfficialCuaFrameResult<
  T extends { content?: unknown; isError?: boolean },
>(result: T, options?: unknown): Promise<T>;

export interface OfficialCuaFrameAttestation {
  kind: string;
  frameId: string;
  mediaType: string;
  width: number;
  height: number;
  sha256: string;
}

export declare function attestOfficialCuaFrameContent(
  content: unknown,
  expectedKind?: string,
): OfficialCuaFrameAttestation | undefined;

export interface OfficialCuaFrameContentPair {
  image: any;
  imageRef: any;
  imageRefIndex: number;
  imageIndex: number;
}

export declare function findOfficialCuaFrameContentPair(
  content: unknown,
): OfficialCuaFrameContentPair | undefined;
