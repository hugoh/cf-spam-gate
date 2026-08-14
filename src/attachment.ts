import { unzipSync } from "fflate";

interface Attachment {
  filename: string | null;
  mimeType: string;
  disposition: "attachment" | "inline" | null;
  content: ArrayBuffer | Uint8Array | string;
}

export const DEFAULT_DANGEROUS_EXTENSIONS = new Set([
  "exe",
  "scr",
  "js",
  "vbs",
  "bat",
  "cmd",
  "msi",
  "com",
  "pif",
  "jar",
  "ps1",
]);

export const DEFAULT_MACRO_EXTENSIONS = new Set(["docm", "xlsm", "pptm"]);
export const DEFAULT_OOXML_ZIP_EXTENSIONS = new Set([
  "docx",
  "xlsx",
  "pptx",
  "docm",
  "xlsm",
  "pptm",
]);

export interface AttachmentScoreConfig {
  dangerousExtensions?: Set<string>;
  macroExtensions?: Set<string>;
  ooxmlZipExtensions?: Set<string>;
}

const VBA_PROJECT_RE = /vbaProject\.bin$/i;

function extensionsOf(filename: string): string[] {
  return filename.toLowerCase().split(".").slice(1);
}

function hasVbaProject(content: ArrayBuffer | Uint8Array | string): boolean {
  if (typeof content === "string") return false;
  const bytes =
    content instanceof Uint8Array ? content : new Uint8Array(content);
  try {
    const entries = unzipSync(bytes, {
      filter: (file) => VBA_PROJECT_RE.test(file.name),
    });
    return Object.keys(entries).length > 0;
  } catch {
    return false;
  }
}

function scoreOne(
  attachment: Attachment,
  dangerousExtensions: Set<string>,
  macroExtensions: Set<string>,
  ooxmlZipExtensions: Set<string>,
): number {
  const filename = attachment.filename ?? "";
  const extensions = extensionsOf(filename);
  const lastExtension = extensions.at(-1);

  if (lastExtension && dangerousExtensions.has(lastExtension)) return 1;

  let score = 0;

  if (lastExtension && macroExtensions.has(lastExtension)) score = 0.7;

  if (lastExtension && ooxmlZipExtensions.has(lastExtension)) {
    if (hasVbaProject(attachment.content)) score = 1;
  }

  return score;
}

/** Attachment risk: dangerous extensions, the double-extension trick, and Office macro content. Takes the max across attachments — one dangerous attachment should flag the whole email. */
export function attachmentScore(
  attachments: Attachment[],
  config: AttachmentScoreConfig = {},
): number {
  if (attachments.length === 0) return 0;

  const dangerousExtensions =
    config.dangerousExtensions ?? DEFAULT_DANGEROUS_EXTENSIONS;
  const macroExtensions = config.macroExtensions ?? DEFAULT_MACRO_EXTENSIONS;
  const ooxmlZipExtensions =
    config.ooxmlZipExtensions ?? DEFAULT_OOXML_ZIP_EXTENSIONS;

  return attachments.reduce(
    (max, a) =>
      Math.max(
        max,
        scoreOne(a, dangerousExtensions, macroExtensions, ooxmlZipExtensions),
      ),
    0,
  );
}
