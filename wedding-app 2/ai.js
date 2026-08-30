// Minimal Anthropic Messages API client, built on Node's built-in `https`
// module only — no @anthropic-ai/sdk dependency, same "no npm install
// needed to run this" philosophy as email.js's Resend client.
//
// Powers the Vendors tab's "Analyze a quote with AI" flow: a couple uploads
// a PDF or photo of a vendor's quote/brochure, this sends it straight to
// Claude (PDFs and images both go in as native document/image content
// blocks — no separate text-extraction step needed), and asks for a
// structured read of the pricing so it can be reviewed and dropped into
// the comparison table.
//
// If ANTHROPIC_API_KEY isn't set, analyzeVendorDocument() resolves with
// { configured: false } so the route above can degrade gracefully instead
// of crashing — same shape as email.js's { skipped: true }.

const https = require("https");

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

const EXTRACT_TOOL = {
  name: "extract_vendor_quote",
  description: "Record what was found in a vendor's quote, contract, or brochure for a wedding.",
  input_schema: {
    type: "object",
    properties: {
      vendorName: { type: "string", description: "The vendor/business name, if it appears in the document." },
      pricingModel: {
        type: "string",
        enum: ["flat", "per_guest", "per_guest_plus_flat", "per_hour", "unknown"],
        description: "How this vendor prices: a single flat fee, a per-guest rate, a flat fee plus a per-guest add-on, an hourly rate, or unknown/other (e.g. tiered packages that don't reduce to one number)."
      },
      basePrice: { type: ["number", "null"], description: "The flat/base fee in USD, or the starting package price. Null if not applicable." },
      perGuestRate: { type: ["number", "null"], description: "The per-guest or per-head rate in USD, if the document has one. Null if not applicable." },
      perHourRate: { type: ["number", "null"], description: "The hourly rate in USD, if the document has one. Null if not applicable." },
      estimatedHours: { type: ["number", "null"], description: "Coverage hours implied by the document (e.g. an 8-hour photography package), if any." },
      minGuests: { type: ["number", "null"], description: "Any stated minimum guest count or minimum spend converted to a guest count, if mentioned." },
      includes: { type: "string", description: "A short plain-English summary of what's included (2-4 sentences or a compact list as prose)." },
      excludesOrFees: { type: "string", description: "Extra fees, exclusions, gratuity/service charge/tax notes, or anything billed separately. Empty string if none mentioned." },
      cancellationNotes: { type: "string", description: "Deposit, cancellation, or refund terms, in plain English. Empty string if not mentioned." },
      redFlags: { type: "string", description: "Anything that looks like a real gotcha worth flagging to the couple — surprise fees, unusual restrictions, a very short response window, etc. Empty string if nothing stands out." },
      summary: { type: "string", description: "A 2-4 sentence plain-English summary of this quote, written for someone comparing several vendors at a glance." },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "How confident this extraction is — 'low' if the document was hard to read, scanned poorly, ambiguous, or clearly incomplete." }
    },
    required: ["pricingModel", "includes", "excludesOrFees", "cancellationNotes", "redFlags", "summary", "confidence"]
  }
};

function callAnthropic(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Could not parse Anthropic API response.")); }
          } else {
            let msg = "Anthropic API error " + res.statusCode;
            try { msg = (JSON.parse(data).error || {}).message || msg; } catch (e) { /* keep default msg */ }
            reject(new Error(msg));
          }
        });
      }
    );
    req.on("error", (e) => reject(e));
    req.write(body);
    req.end();
  });
}

// { category, guestCount, filename, mimeType, fileBase64 } -> { configured, extracted } | throws
async function analyzeVendorDocument({ category, guestCount, filename, mimeType, fileBase64 }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { configured: false };
  }

  const isImage = /^image\//.test(mimeType);
  const isPdf = mimeType === "application/pdf";
  if (!isImage && !isPdf) {
    const err = new Error("Only PDF or image files can be analyzed.");
    err.userFacing = true;
    throw err;
  }

  const docBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data: fileBase64 } };

  const promptText = "This is a quote, contract, or brochure from a wedding vendor in the \"" + category +
    "\" category" + (filename ? " (file: " + filename + ")" : "") + "." +
    (guestCount ? " The couple currently expects about " + guestCount + " guests." : "") +
    " Read it and call extract_vendor_quote with what you find. If a figure genuinely isn't in the document, use null (for numbers) or an empty string (for text) rather than guessing.";

  const response = await callAnthropic({
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: 1024,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_vendor_quote" },
    messages: [
      { role: "user", content: [docBlock, { type: "text", text: promptText }] }
    ]
  });

  const toolUse = (response.content || []).filter((b) => b.type === "tool_use" && b.name === "extract_vendor_quote")[0];
  if (!toolUse) {
    throw new Error("The model didn't return a structured result — try again.");
  }
  return { configured: true, extracted: toolUse.input };
}

module.exports = { analyzeVendorDocument };
