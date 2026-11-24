/*
 * Diolog fork: AI visual check for the real-browser monitor.
 *
 * The monitor takes a screenshot of the rendered page; this sends it to a vision model on Amazon
 * Bedrock (GPT-6 Luna by default, medium reasoning effort) and turns the verdict into UP or DOWN.
 * A check that cannot run (Bedrock refused, the reply was unreadable) fails the beat with that
 * reason rather than passing it, so a broken checker is visible on the dashboard.
 *
 * Configuration (all optional):
 *   UPTIME_KUMA_AI_MODEL    Bedrock model or inference-profile id (default global.openai.gpt-6-luna)
 *   UPTIME_KUMA_AI_EFFORT   reasoning effort: low | medium | high (default medium)
 *   AWS_REGION              Bedrock region (default ap-southeast-2)
 * Credentials come from the AWS SDK's default chain: on the status cell that is the EC2 instance role.
 */
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const MODEL = process.env.UPTIME_KUMA_AI_MODEL || "global.openai.gpt-6-luna";
const EFFORT = process.env.UPTIME_KUMA_AI_EFFORT || "medium";
const REGION = process.env.AWS_REGION || "ap-southeast-2";

const SYSTEM_PROMPT = `You review screenshots of live websites for an uptime monitor. Decide whether the page, as a visitor sees it right now, has an obvious problem.

Report a problem only when you can see one of these:
- an error page: 404, 500, 502, 503, "Application error", "This page could not be found", "Deployment not found", a hosting or CDN error page, a stack trace;
- a blank or nearly blank page, or a page stuck on a loading spinner with no content;
- styles that failed to load: unstyled HTML, default serif fonts and underlined blue links across the page;
- a layout so broken that content overlaps or is cut off and cannot be read;
- broken-image icons where the logo or main images should be;
- raw code or placeholders shown as text, such as {{name}}, undefined, NaN, null or [object Object];
- a maintenance, "coming soon" or domain-parking page where a real site should be;
- anything the page's stated expectations say must be present but is missing.

Do not report matters of taste, wording, small spacing differences, images below the fold that are still lazy-loading, or an ordinary cookie or consent banner.

Reply with one JSON object and nothing else:
{"verdict": "ok" | "problem", "summary": "<one sentence a person on call can act on>", "issues": ["<each problem you saw>"]}`;

let client = null;

/**
 * @returns {BedrockRuntimeClient} shared client
 */
function getClient() {
    if (!client) {
        client = new BedrockRuntimeClient({ region: REGION });
    }
    return client;
}

/**
 * Pull the JSON verdict out of the model's reply.
 * @param {string} text model output
 * @returns {{verdict: "ok"|"problem", summary: string, issues: string[]}} parsed verdict
 */
function parseVerdict(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
        throw new Error(`Visual check reply had no JSON verdict: ${text.slice(0, 200)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
        throw new Error(`Visual check reply was not valid JSON (${e.message}): ${text.slice(0, 200)}`);
    }
    if (parsed.verdict !== "ok" && parsed.verdict !== "problem") {
        throw new Error(`Visual check verdict must be "ok" or "problem", got ${JSON.stringify(parsed.verdict)}`);
    }
    if (typeof parsed.summary !== "string" || parsed.summary.trim() === "") {
        throw new Error("Visual check verdict had no summary");
    }
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i) => typeof i === "string") : [];
    return { verdict: parsed.verdict, summary: parsed.summary.trim(), issues };
}

/**
 * Ask the vision model whether the screenshot shows an obvious problem.
 * @param {object} input what the model is shown
 * @param {Buffer} input.image JPEG screenshot of the rendered page
 * @param {string} input.url page URL
 * @param {number} input.status HTTP status of the page load
 * @param {string} input.title document title
 * @param {string|null} input.expectations the monitor's own description of what must be on the page
 * @returns {Promise<{verdict: "ok"|"problem", summary: string, issues: string[], model: string}>} verdict
 */
async function checkScreenshot({ image, url, status, title, expectations }) {
    const context = [
        `URL: ${url}`,
        `HTTP status: ${status}`,
        `Page title: ${title || "(none)"}`,
        `Expectations for this page: ${expectations && expectations.trim() ? expectations.trim() : "none given beyond the general rules"}`,
    ].join("\n");

    let response;
    try {
        response = await getClient().send(
            new ConverseCommand({
                modelId: MODEL,
                system: [{ text: SYSTEM_PROMPT }],
                messages: [
                    {
                        role: "user",
                        content: [{ image: { format: "jpeg", source: { bytes: image } } }, { text: context }],
                    },
                ],
                inferenceConfig: { maxTokens: 4000 },
                additionalModelRequestFields: { reasoning: { effort: EFFORT } },
            })
        );
    } catch (e) {
        throw new Error(`Visual check could not run (${MODEL}): ${e.name}: ${e.message}`);
    }

    const text = (response.output?.message?.content || [])
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n");
    if (!text) {
        throw new Error(`Visual check got no text from ${MODEL} (stop reason ${response.stopReason})`);
    }
    return { ...parseVerdict(text), model: MODEL };
}

module.exports = { checkScreenshot, parseVerdict };
