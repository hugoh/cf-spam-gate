import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { attachmentScore } from "../src/attachment";

function attachment(filename: string, mimeType = "application/octet-stream") {
  return {
    filename,
    mimeType,
    disposition: "attachment" as const,
    content: new Uint8Array(),
  };
}

function officeZip(entries: Record<string, string>) {
  const files: Record<string, Uint8Array> = {};
  for (const [name, contents] of Object.entries(entries)) {
    files[name] = new TextEncoder().encode(contents);
  }
  return zipSync(files);
}

describe("attachmentScore", () => {
  it("is 0 for no attachments", () => {
    expect(attachmentScore([])).toBe(0);
  });

  it("is 0 for a clean PDF", () => {
    expect(
      attachmentScore([attachment("invoice.pdf", "application/pdf")]),
    ).toBe(0);
  });

  it("is 1 for a dangerous executable extension", () => {
    expect(attachmentScore([attachment("setup.exe")])).toBe(1);
  });

  it("is 1 for the double-extension trick", () => {
    expect(attachmentScore([attachment("invoice.pdf.exe")])).toBe(1);
  });

  it("scores a plain macro-enabled filename below the dangerous-extension max", () => {
    const score = attachmentScore([attachment("form.docm")]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("is 1 for an OOXML docx that actually contains a macro project", () => {
    const content = officeZip({
      "word/document.xml": "<xml/>",
      "word/vbaProject.bin": "macro-bytes",
    });
    expect(
      attachmentScore([
        {
          filename: "resume.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          disposition: "attachment",
          content,
        },
      ]),
    ).toBe(1);
  });

  it("is 0 for a docx with no macro project", () => {
    const content = officeZip({ "word/document.xml": "<xml/>" });
    expect(
      attachmentScore([
        {
          filename: "resume.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          disposition: "attachment",
          content,
        },
      ]),
    ).toBe(0);
  });

  it("honors a custom dangerous-extensions config over the default list", () => {
    expect(
      attachmentScore([attachment("setup.exe")], {
        dangerousExtensions: new Set(),
      }),
    ).toBe(0);
    expect(
      attachmentScore([attachment("data.csv")], {
        dangerousExtensions: new Set(["csv"]),
      }),
    ).toBe(1);
  });

  it("takes the max across multiple attachments rather than averaging", () => {
    const score = attachmentScore([
      attachment("invoice.pdf", "application/pdf"),
      attachment("setup.exe"),
    ]);
    expect(score).toBe(1);
  });
});
