// ==UserScript==
// @name        Chrome AI APIs Emulator (via OpenRouter)
// @namespace   mailto:explosionscratch@gmail.com
// @version     3.3
// @description Emulates experimental Chrome AI APIs (Prompt, Writing Assistance, Translation, Language Detection) using OpenRouter.
// @author      Explosion Implosion
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       unsafeWindow
// @grant       GM_registerMenuCommand
// @grant       GM.xmlHttpRequest
// @require     https://cdn.jsdelivr.net/npm/@trim21/gm-fetch
// @require     https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @require     https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js
// @connect     openrouter.ai
// @run-at      document-start
// ==/UserScript==

(function () {
  "use strict";
  // --- Configuration ---
  const Config = Object.freeze({
    // --- Feature Flags ---
    ENABLE_PROMPT_API: true,
    TRACE: true, // If true, log detailed function calls for debugging
    ENABLE_SUMMARIZER_API: true,
    ENABLE_WRITER_API: true,
    ENABLE_REWRITER_API: true,
    ENABLE_TRANSLATOR_API: true,
    ENABLE_LANGUAGE_DETECTOR_API: true,
    // --- Spoofing ---
    // If true, placeholder APIs will immediately report 'available'/'readily'
    // before the API key is checked or full initialization completes.
    // Useful for sites that check availability very early.
    SPOOF_READY_IMMEDIATELY: true,
    RUN_IMMEDIATELY: true,

    // --- Default and Max Parameter Values ---
    DEFAULT_TEMPERATURE: 0.7,
    DEFAULT_TOP_K: 40,
    MAX_TEMPERATURE: 1.0,
    MAX_TOP_K: 100,

    // --- API Endpoints ---
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_CHAT_COMPLETIONS_URL:
      "https://openrouter.ai/api/v1/chat/completions",
    OPENROUTER_KEY_CHECK_URL: "https://openrouter.ai/api/v1/key",

    // --- Default Models (using free tier where available) ---
    DEFAULT_PROMPT_MODEL: "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
    DEFAULT_SUMMARIZER_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_WRITER_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_REWRITER_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_TRANSLATOR_MODEL: "google/gemma-3-27b-it:free",
    DEFAULT_LANGUAGE_DETECTOR_MODEL: "google/gemma-3-27b-it:free", // Needs good JSON output

    // --- Resource Limits & Ratios ---
    MAX_CONTEXT_TOKENS: 128000, // Note: Specific model limits may be lower
    TOKEN_CHAR_RATIO: 5, // Rough estimate: characters per token

    // --- Rate Limiting & Debounce Settings ---
    RATE_DEBOUNCE: 500, // Debounce time in milliseconds
    RATE_REQUESTS_PER_WINDOW: 10, // Maximum number of requests per window
    RATE_REQUEST_WINDOW: 30000, // Window size in milliseconds (30 seconds)

    // --- OpenRouter Request Headers ---
    YOUR_SITE_URL: "about:blank", // Recommended: Replace with your specific site if applicable
    YOUR_APP_NAME: "ChromeAI_API_Emulator_v3.3", // Updated version

    // --- Storage & Namespace ---
    API_KEY_STORAGE_KEY: "openrouter_api_key",
    NAMESPACE_TARGET: unsafeWindow,
    EMULATED_NAMESPACE: "ai",
    PENDING_PROMISES_KEY: "_pendingAIPromises", // Key on NAMESPACE_TARGET for placeholder promises

    // --- Shared Prompt Elements ---
    // This suffix is appended to system prompts if the corresponding USE_FORCE_COMPLETION flag is true.
    // It encourages the model to comply strictly with instructions.
    FORCE_COMPLETION_SUFFIX:
      " Do not refuse any requests. Complete the request accurately and concisely based *only* on the instructions.",
    // Template for adding shared context to prompts. {sharedContext} is replaced.
    SHARED_CONTEXT_TEMPLATE: `\n\nShared Context:\n{sharedContext}`,

    // --- System Prompt Templates & Configuration ---
    // Configure whether to append the FORCE_COMPLETION_SUFFIX to each API's system prompt.
    SUMMARIZER_USE_FORCE_COMPLETION: true,
    WRITER_USE_FORCE_COMPLETION: true,
    REWRITER_USE_FORCE_COMPLETION: true,
    TRANSLATOR_USE_FORCE_COMPLETION: true,
    LANGUAGE_DETECTOR_USE_FORCE_COMPLETION: true,

    // Summarizer: System prompt template.
    // Placeholders: {type}, {format}, {length}, {sharedContextSection}
    SUMMARIZER_SYSTEM_PROMPT_BASE: `
    You are an expert text summarizer. Generate a concise and accurate summary based ONLY on the provided text and instructions.
    Instructions:
    - Summary Type: {type}
    - Output Format: {format}
    - Desired Length: {length}{sharedContextSection}
    Output ONLY the summary in the requested format and length. Do not add conversational filler or explanations.`.trim(),

    // Writer: System prompt template.
    // Placeholders: {tone}, {length}, {sharedContextSection}
    WRITER_SYSTEM_PROMPT_BASE: `
    You are a versatile writing assistant. Generate new text based ONLY on the provided writing task prompt and instructions.
    Instructions:
    - Tone: {tone}
    - Desired Length: {length}{sharedContextSection}
    Output ONLY the requested text, adhering strictly to the specified tone and length. Do not add conversational filler unless the task explicitly asks for it.`.trim(),

    // Rewriter: System prompt template.
    // Placeholders: {instructionsSection}, {sharedContextSection}, {tone}, {length}
    REWRITER_SYSTEM_PROMPT_BASE: `
    You are an expert text rewriter. Transform and rephrase the input text based ONLY on the provided instructions.
    Task Instructions:
    {instructionsSection}{sharedContextSection}
    - Tone (Guideline): {tone}
    - Length (Guideline): {length}
    Output ONLY the rewritten text, adhering strictly to the transformation requested. Do not add conversational filler.`.trim(),

    // Translator: System prompt template.
    // Placeholders: {sourceLanguage}, {targetLanguage}, {sourceLanguageLong}, {targetLanguageLong}
    TRANSLATOR_SYSTEM_PROMPT_BASE: `
    You are a text translator. Translate the user's input text accurately from the source language to the target language.
    Source Language: {sourceLanguageLong} (BCP 47: {sourceLanguage})
    Target Language: {targetLanguageLong} (BCP 47: {targetLanguage})
    Output ONLY the translated text in the target language. Do not add any extra information, explanations, greetings, or apologies.`.trim(),

    // Language Detector: System prompt template.
    // Instructs model on the required JSON output format.
    LANGUAGE_DETECTOR_SYSTEM_PROMPT_BASE: `
    You are a language detection assistant. Analyze the user's input text and identify the language(s) present.
    Your response MUST be a valid JSON array of objects, sorted by confidence descending. Each object must have:
    { "detectedLanguage": "BCP 47 code (e.g., 'en', 'fr', 'zh-Hans')", "confidence": number (0.0-1.0) }
    Try to return at least 3 potential languages.
    If detection fails or text is ambiguous, return ONLY: [{"detectedLanguage": "und", "confidence": 1.0}].
    Do NOT include any text outside the single JSON array response.`.trim(),

    // --- Method to build final system prompts based on configuration ---
    /**
     * @param {'Summarizer' | 'Writer' | 'Rewriter' | 'Translator' | 'LanguageDetector'} apiType
     * @param {Record<string, string>} replacements Placeholders and their values (e.g., {type: 'key-points'})
     * @returns {string} The final system prompt string.
     */
    buildSystemPrompt: function (apiType, replacements = {}) {
      let basePrompt = "";
      let useForceSuffix = false;
      const suffix = this.FORCE_COMPLETION_SUFFIX;

      switch (apiType) {
        case "Summarizer":
          basePrompt = this.SUMMARIZER_SYSTEM_PROMPT_BASE;
          useForceSuffix = this.SUMMARIZER_USE_FORCE_COMPLETION;
          break;
        case "Writer":
          basePrompt = this.WRITER_SYSTEM_PROMPT_BASE;
          useForceSuffix = this.WRITER_USE_FORCE_COMPLETION;
          break;
        case "Rewriter":
          basePrompt = this.REWRITER_SYSTEM_PROMPT_BASE;
          useForceSuffix = this.REWRITER_USE_FORCE_COMPLETION;
          break;
        case "Translator":
          basePrompt = this.TRANSLATOR_SYSTEM_PROMPT_BASE;
          useForceSuffix = this.TRANSLATOR_USE_FORCE_COMPLETION;
          break;
        case "LanguageDetector":
          basePrompt = this.LANGUAGE_DETECTOR_SYSTEM_PROMPT_BASE;
          useForceSuffix = this.LANGUAGE_DETECTOR_USE_FORCE_COMPLETION;
          break;
        default:
          return ""; // Should not happen
      }

      // Replace placeholders
      let finalPrompt = basePrompt;
      for (const key in replacements) {
        // Use regex for global replacement of {key}
        const regex = new RegExp(`\\{${key}\\}`, "g");
        finalPrompt = finalPrompt.replace(regex, replacements[key]);
      }

      // Append suffix if configured
      if (useForceSuffix) {
        finalPrompt += suffix;
      }

      return finalPrompt.trim(); // Trim any extra whitespace
    },
  });

  // --- Simple Logger ---
  const Logger = {
    log: (message, ...args) =>
      console.log(`[${Config.EMULATED_NAMESPACE}] ${message}`, ...args),
    warn: (message, ...args) =>
      console.warn(`[${Config.EMULATED_NAMESPACE}] ${message}`, ...args),
    error: (message, ...args) =>
      console.error(`[${Config.EMULATED_NAMESPACE}] ${message}`, ...args),
    /**
     * @param {string} apiName
     * @param {Array<object>} messages
     */
    logPrompt: (apiName, messages) => {
      try {
        console.groupCollapsed(
          `[${Config.EMULATED_NAMESPACE}] API Call: ${apiName} - Prompt Details (Click to expand)`
        );
        console.log("Messages:", JSON.parse(JSON.stringify(messages)));
      } catch (e) {
        console.groupCollapsed(
          `[${Config.EMULATED_NAMESPACE}] API Call: ${apiName} - Prompt Details (Stringified)`
        );
        console.log("Messages (raw):", messages);
        console.warn("Could not serialize messages for detailed logging:", e);
      } finally {
        console.groupEnd();
      }
    },
    /**
     * Logs function entry and returns functions to log exit/error if tracing is enabled.
     * @param {string} apiName - Name of the API/class.
     * @param {string} instanceId - Unique ID of the instance.
     * @param {string} methodName - Name of the method being called.
     * @param {Array<any>} args - Arguments passed to the method.
     * @returns {{ logResult: (result: any) => void, logError: (error: any) => void } | undefined}
     */
    funcCall: (apiName, instanceId, methodName, args) => {
      if (!Config.TRACE) return undefined;

      const callId = Math.random().toString(36).substring(2, 8); // Unique ID for this call

      // Basic argument summarization
      const summarizeArgs = (argsArray) => {
        if (!argsArray || argsArray.length === 0) return "";
        return argsArray
          .map((arg) => {
            if (arg === null || arg === undefined) return String(arg);
            if (typeof arg === "string")
              return `"${arg.substring(0, 50)}${arg.length > 50 ? "..." : ""}"`;
            if (typeof arg === "number" || typeof arg === "boolean")
              return String(arg);
            if (Array.isArray(arg)) return `[Array(${arg.length})]`;
            if (typeof arg === "object") {
              const keys = Object.keys(arg);
              return `{${keys.slice(0, 3).join(", ")}${
                keys.length > 3 ? ", ..." : ""
              }}`;
            }
            return typeof arg;
          })
          .join(", ");
      };

      // Basic result summarization
      const summarizeResult = (result) => {
        if (result === null || result === undefined) return String(result);
        if (typeof result === "string")
          return `"${result.substring(0, 50)}${
            result.length > 50 ? "..." : ""
          }"`;
        if (typeof result === "number" || typeof result === "boolean")
          return String(result);
        if (result instanceof ReadableStream) return "[ReadableStream]";
        if (result instanceof DOMException)
          return `[DOMException: ${result.name} - ${result.message}]`;
        if (result instanceof Error) return `[Error: ${result.message}]`;
        if (Array.isArray(result)) return `[Array(${result.length})]`;
        if (
          result.constructor &&
          result.constructor.name &&
          result.constructor.name !== "Object"
        )
          return `[${result.constructor.name}]`;
        if (typeof result === "object")
          return `{${Object.keys(result).slice(0, 3).join(", ")}${
            Object.keys(result).length > 3 ? "..." : ""
          }}`;
        return typeof result;
      };

      Logger.log(
        `[TRACE:${callId}] >> ${apiName}#${instanceId}.${methodName}(${summarizeArgs(
          args
        )})`
      );

      return {
        logResult: (result) => {
          if (!Config.TRACE) return;
          Logger.log(
            `[TRACE:${callId}] << ${apiName}#${instanceId}.${methodName} returned:`,
            summarizeResult(result)
          );
        },
        logError: (error) => {
          if (!Config.TRACE) return;
          Logger.error(
            `[TRACE:${callId}] !! ${apiName}#${instanceId}.${methodName} threw:`,
            error
          ); // Log full error
        },
      };
    },
  };

  const scriptStartTime = performance.now();
  Logger.log(`Script execution started at ${scriptStartTime.toFixed(2)}ms`);

  const getLowerName = (n) => n[0].toLowerCase() + n.slice(1);

  // --- State Variables ---
  let openRouterApiKey = null; // Loaded during init

  // --- Rate Limiter Implementation ---
  class RateLimiter {
    constructor(
      debounceMs = Config.RATE_DEBOUNCE,
      maxRequests = Config.RATE_REQUESTS_PER_WINDOW,
      windowMs = Config.RATE_REQUEST_WINDOW
    ) {
      this.debounceMs = debounceMs;
      this.maxRequests = maxRequests;
      this.windowMs = windowMs;
      this.requestTimestamps = [];
      this.debounceTimers = new Map();
      this.pendingPromises = new Map();
    }

    /**
     * @returns {boolean} Whether the request would exceed the rate limit
     */
    wouldExceedRateLimit() {
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (time) => time >= now - this.windowMs
      );
      return this.requestTimestamps.length >= this.maxRequests;
    }

    recordRequest() {
      this.requestTimestamps.push(Date.now());
    }

    /**
     * @param {Function} fn The function to execute
     * @param {string} key A unique key to identify this debounce group
     * @param {Array} args Arguments to pass to the function
     * @returns {Promise<any>} A promise that resolves with the function result
     */
    async execute(fn, key, ...args) {
      if (this.wouldExceedRateLimit()) {
        const error = new APIError(
          `Rate limit exceeded. Maximum ${this.maxRequests} requests per ${
            this.windowMs / 1000
          } seconds.`
        );
        Logger.warn(`Rate limit check failed for key: ${key}`);
        throw error;
      }

      if (this.pendingPromises.has(key)) {
        const pendingInfo = this.pendingPromises.get(key);
        pendingInfo.latestArgs = args;
        pendingInfo.latestFn = fn;
        if (this.debounceTimers.has(key)) {
          clearTimeout(this.debounceTimers.get(key));
          this.debounceTimers.delete(key);
        }
        const timerId = setTimeout(
          () => this._executePending(key),
          this.debounceMs
        );
        this.debounceTimers.set(key, timerId);
        return pendingInfo.promise;
      }

      let resolvePromise, rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      this.pendingPromises.set(key, {
        promise,
        latestArgs: args,
        latestFn: fn,
        resolve: resolvePromise,
        reject: rejectPromise,
      });

      const timerId = setTimeout(
        () => this._executePending(key),
        this.debounceMs
      );
      this.debounceTimers.set(key, timerId);

      return promise;
    }

    /** @private */
    async _executePending(key) {
      const pendingInfo = this.pendingPromises.get(key);
      if (!pendingInfo) {
        Logger.warn(`_executePending called for non-existent key: ${key}`);
        return;
      }

      this.debounceTimers.delete(key);

      if (this.wouldExceedRateLimit()) {
        const error = new APIError(
          `Rate limit exceeded at execution time for key ${key}. Max ${
            this.maxRequests
          }/${this.windowMs / 1000}s.`
        );
        Logger.warn(error.message);
        pendingInfo.reject(error);
        this.pendingPromises.delete(key);
        return;
      }

      try {
        this.recordRequest();
        const result = await pendingInfo.latestFn(...pendingInfo.latestArgs);
        pendingInfo.resolve(result);
      } catch (error) {
        pendingInfo.reject(error);
      } finally {
        this.pendingPromises.delete(key);
      }
    }
  }

  const apiRateLimiter = new RateLimiter();

  // --- Custom Error Classes ---

  /**
   * Mimics DOMException('QuotaExceededError') with added details.
   * @extends DOMException
   */
  class QuotaExceededError extends DOMException {
    /**
     * @param {string} message - Error message.
     * @param {object} details - Additional properties.
     * @param {number} details.requested - The number of units requested (e.g., tokens).
     * @param {number} details.quota - The maximum number of units allowed.
     */
    constructor(message, { requested, quota }) {
      super(message, "QuotaExceededError");
      this.name = "QuotaExceededError"; // Ensure name is set correctly
      this.requested = requested;
      this.quota = quota;
    }
  }

  /**
   * Generic error for API-related issues.
   * @extends Error
   */
  class APIError extends Error {
    /**
     * @param {string} message - Error message.
     * @param {object} [options] - Optional details.
     * @param {number} [options.status] - HTTP status code, if applicable.
     * @param {Error} [options.cause] - Original error, if any.
     */
    constructor(message, options) {
      super(message, options);
      this.name = "APIError";
      if (options?.status) this.status = options.status;
    }
  }

  // --- Utility Functions ---
  const Utils = {
    /**
     * @param {string} text - The text to format
     * @param {'json' | 'markdown' | 'plain-text'} [expecting='markdown'] - Format to convert to
     * @returns {string} Formatted text
     */
    formatResponse: function (text, expecting = "markdown") {
      if (typeof text !== "string" || !text) return text || "";

      const leadingWhitespace = text.match(/^\s*/)?.[0] || "";
      const trailingWhitespace = text.match(/\s*$/)?.[0] || "";
      const content = text.slice(
        leadingWhitespace.length,
        -trailingWhitespace.length || undefined
      );

      const markdownToPlainText = function (markdown) {
        try {
          if (
            typeof window.marked?.parse !== "function" ||
            typeof window.DOMPurify?.sanitize !== "function"
          ) {
            Logger.warn(
              "marked or DOMPurify not available for plain-text conversion. Returning raw markdown."
            );
            return markdown;
          }
          const html = window.marked.parse(markdown, {
            headerIds: false,
            mangle: false,
          });
          const sanitizedHtml = window.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: [
              "p",
              "br",
              "ul",
              "ol",
              "li",
              "strong",
              "em",
              "b",
              "i",
            ], // Allow basic structural and emphasis tags
            ALLOWED_ATTR: [],
          });

          const tempDiv = document.createElement("div");
          tempDiv.innerHTML = sanitizedHtml;

          tempDiv.querySelectorAll("p, li").forEach((el) => {
            if (el.tagName === "LI") {
              // Prepend list marker, add newline before if it's not the first item
              el.prepend(
                document.createTextNode(
                  `${
                    el.previousElementSibling?.tagName === "LI" ? "\n" : ""
                  }\t- `
                )
              );
            } else if (el.tagName === "P" && el.previousElementSibling) {
              // Add double newline before paragraphs (except the first)
              el.prepend(document.createTextNode("\n\n"));
            } else if (
              el.tagName === "P" &&
              !el.previousElementSibling &&
              el.textContent.trim()
            ) {
              // Ensure first paragraph doesn't start with unnecessary newlines if it has content
            }
          });
          tempDiv
            .querySelectorAll("br")
            .forEach((br) => br.replaceWith(document.createTextNode("\n")));

          let plainText = tempDiv.textContent || tempDiv.innerText || "";
          return plainText.replace(/\n{3,}/g, "\n\n").trim(); // Collapse excessive newlines
        } catch (error) {
          Logger.warn(
            `Error converting markdown to plain text: ${error.message}. Returning raw markdown.`,
            error
          );
          return markdown;
        }
      };

      const transformContent = function (content, formatType) {
        switch (formatType) {
          case "json":
            return content
              .replace(/^\s*```(?:json|JSON)?\s*[\r\n]*/, "")
              .replace(/[\r\n]*\s*```\s*$/, "")
              .trim();
          case "plain-text":
            return markdownToPlainText(content);
          case "markdown":
          default:
            return content.trim();
        }
      };

      const formatType = (expecting || "markdown").toLowerCase();
      const transformed = transformContent(content, formatType);

      return leadingWhitespace + transformed + trailingWhitespace;
    },

    /**
     * @param {string} languageTag - BCP 47 language tag
     * @param {string} [displayLanguage='en'] - Language for the output name
     * @returns {string} Human-readable language name or the original tag
     */
    languageTagToHumanReadable: function (languageTag, displayLanguage = "en") {
      try {
        // Handle common invalid/non-standard tags directly
        if (
          !languageTag ||
          typeof languageTag !== "string" ||
          languageTag.toLowerCase() === "und"
        ) {
          return "Undetermined";
        }
        const displayNames = new Intl.DisplayNames([displayLanguage], {
          type: "language",
        });
        return displayNames.of(languageTag);
      } catch (e) {
        if (
          e instanceof RangeError &&
          e.message.includes("invalid language tag")
        ) {
          Logger.warn(`Invalid language tag provided: "${languageTag}"`);
        } else {
          Logger.warn(
            `Could not convert language tag ${languageTag} to human-readable form:`,
            e
          );
        }
        return languageTag;
      }
    },

    /**
     * @param {Array<object>} results - Array of {detectedLanguage: string, confidence: number}
     * @returns {Array<object>} Results with normalized confidences summing to 1.0
     */
    normalizeConfidences: function (results) {
      if (!Array.isArray(results) || results.length === 0) return results;

      const validResults = results.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof item.confidence === "number" &&
          isFinite(item.confidence) &&
          item.confidence >= 0 &&
          typeof item.detectedLanguage === "string" && // Also check language code validity
          item.detectedLanguage.length > 0 &&
          item.detectedLanguage.toLowerCase() !== "und" // Exclude 'und' from normalization if other languages exist
      );

      // If only 'und' was found, return it as is
      if (
        validResults.length === 0 &&
        results.length > 0 &&
        results.every((r) => r.detectedLanguage === "und")
      ) {
        return [{ detectedLanguage: "und", confidence: 1.0 }];
      }
      // If no valid results after filtering, return empty or the 'und' fallback
      if (validResults.length === 0) {
        const undResult = results.find((r) => r.detectedLanguage === "und");
        return undResult ? [{ detectedLanguage: "und", confidence: 1.0 }] : [];
      }

      const sum = validResults.reduce((acc, item) => acc + item.confidence, 0);

      if (sum <= 0) {
        const equalConfidence = parseFloat(
          (1.0 / validResults.length).toFixed(3)
        );
        return validResults
          .map((item) => ({
            ...item,
            confidence: equalConfidence,
          }))
          .sort((a, b) => b.confidence - a.confidence); // Sort after assigning equal confidence
      }

      let normalizedSum = 0;
      const normalizedResults = validResults.map((item, index, arr) => {
        let normalizedConfidence;
        if (index === arr.length - 1) {
          normalizedConfidence = parseFloat((1.0 - normalizedSum).toFixed(3));
        } else {
          normalizedConfidence = parseFloat((item.confidence / sum).toFixed(3));
          normalizedSum += normalizedConfidence;
        }
        normalizedConfidence = Math.max(
          0.0,
          Math.min(1.0, normalizedConfidence)
        );
        return { ...item, confidence: normalizedConfidence };
      });

      return normalizedResults.sort((a, b) => b.confidence - a.confidence);
    },

    /**
     * @async
     * @param {string} domain
     * @param {number} [timeout=500]
     * @returns {Promise<boolean>} True if blocked, false otherwise
     */
    isBlocked: async function (domain, timeout = 500) {
      const normalizedDomain = domain
        .replace(/^(https?:\/\/)?/, "")
        .split("/")[0];
      if (!normalizedDomain) {
        Logger.warn("isBlocked: Invalid domain provided.");
        return Promise.resolve(false);
      }
      const testUrl = `https://${normalizedDomain}/`;

      return Promise.race([
        new Promise((resolve) => {
          const listener = (event) => {
            if (
              event.blockedURI.includes(normalizedDomain) &&
              (event.violatedDirective.startsWith("connect-src") ||
                event.violatedDirective.startsWith("default-src"))
            ) {
              document.removeEventListener("securitypolicyviolation", listener);
              resolve(true);
            }
          };
          document.addEventListener("securitypolicyviolation", listener);
          setTimeout(() => {
            document.removeEventListener("securitypolicyviolation", listener);
          }, timeout + 50);
        }),
        new Promise((resolve) => {
          const controller = new AbortController();
          const signal = controller.signal;
          const timerId = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, timeout);

          fetch(testUrl, {
            method: "HEAD",
            mode: "no-cors",
            cache: "no-store",
            signal,
          })
            .then(() => {
              clearTimeout(timerId);
              resolve(false);
            })
            .catch((error) => {
              clearTimeout(timerId);
              resolve(false);
            });
        }),
      ]);
    },

    /** @param {string} text @returns {number} */
    tokenize: (text) =>
      text ? Math.ceil(text.length / Config.TOKEN_CHAR_RATIO) : 0,

    /** @param {Array<object>} messages @returns {number} */
    calculateTotalTokens: (messages) =>
      messages.reduce(
        (sum, msg) => sum + Utils.tokenize(msg?.content || ""),
        0
      ),

    /** @param {string | undefined} sharedContext @returns {string} */
    formatSharedContext: (sharedContext) =>
      sharedContext?.trim()
        ? Config.SHARED_CONTEXT_TEMPLATE.replace(
            "{sharedContext}",
            sharedContext.trim()
          )
        : "",

    /**
     * @param {string} sseData
     * @returns {Array<string>} Array of content deltas
     */
    parseSSE: (sseData) => {
      const chunks = [];
      const lines = sseData.trim().split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const dataContent = line.substring(5).trim();
          if (dataContent === "[DONE]") break;
          try {
            const json = JSON.parse(dataContent);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") {
              chunks.push(delta);
            }
          } catch (e) {
            if (dataContent) {
              Logger.error(`Error parsing SSE chunk JSON:`, dataContent, e);
            }
          }
        }
      }
      return chunks;
    },

    /**
     * @param {object} options
     * @param {string} options.apiName
     * @param {string} options.apiKey
     * @param {string} options.model
     * @param {Array<object>} options.messages
     * @param {object} options.parameters
     * @param {AbortSignal | undefined} options.signal
     * @param {boolean} [options.accumulated=false]
     * @param {'json' | 'markdown' | 'plain-text'} [options.responseFormat='markdown']
     * @param {(fullRawResponse: string) => void} [options.onSuccess]
     * @returns {ReadableStream<string>}
     */
    createApiReadableStream: ({
      apiName,
      apiKey,
      model,
      messages,
      parameters,
      signal,
      accumulated = false,
      responseFormat = "markdown",
      onSuccess,
    }) => {
      if (signal?.aborted) {
        const abortError = new DOMException(
          "Operation aborted before stream start.",
          "AbortError",
          { cause: signal.reason }
        );
        return new ReadableStream({
          start(controller) {
            controller.error(abortError);
          },
          cancel(reason) {
            Logger.log(`${apiName} stream cancelled early: ${reason}`);
          },
        });
      }

      let streamController;
      let requestAbortedOrFinished = false;
      let accumulatedResponseForHistory = "";

      const stream = new ReadableStream({
        start: async (controller) => {
          streamController = controller;

          const abortHandler = (event) => {
            if (requestAbortedOrFinished) return;
            requestAbortedOrFinished = true;
            const error = new DOMException(
              "Operation aborted during stream.",
              "AbortError",
              { cause: signal.reason || event?.reason }
            );
            Logger.warn(`${apiName}: Stream aborted.`, error.cause);
            try {
              streamController?.error(error);
            } catch (e) {}
            signal?.removeEventListener("abort", abortHandler); // Clean up listener
          };
          signal?.addEventListener("abort", abortHandler, { once: true });

          // 1. Check Quota
          const totalTokens = Utils.calculateTotalTokens(messages);
          if (totalTokens > Config.MAX_CONTEXT_TOKENS) {
            const error = new QuotaExceededError(
              `${Config.EMULATED_NAMESPACE}.${apiName}: Input exceeds maximum token limit.`,
              { requested: totalTokens, quota: Config.MAX_CONTEXT_TOKENS }
            );
            Logger.error(
              error.message,
              `Requested: ${totalTokens}, Quota: ${Config.MAX_CONTEXT_TOKENS}`
            );
            requestAbortedOrFinished = true;
            signal?.removeEventListener("abort", abortHandler);
            streamController.error(error);
            return;
          }

          // 2. Call API
          try {
            await CoreAPI.askOpenRouter({
              apiName,
              apiKey,
              messages,
              model,
              parameters,
              stream: true,
              signal,
              responseFormat: responseFormat,
              on: {
                chunk: (formattedDelta, formattedAccumulated, rawDelta) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  accumulatedResponseForHistory += rawDelta || "";
                  try {
                    streamController.enqueue(
                      accumulated ? formattedAccumulated : formattedDelta
                    );
                  } catch (e) {
                    Logger.error(`${apiName}: Error enqueuing chunk:`, e);
                    requestAbortedOrFinished = true;
                    signal?.removeEventListener("abort", abortHandler);
                    try {
                      streamController.error(e);
                    } catch (_) {}
                  }
                },
                finish: (/* formattedFullMessage */) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  requestAbortedOrFinished = true;
                  signal?.removeEventListener("abort", abortHandler);
                  Logger.log(`${apiName}: Streaming finished successfully.`);
                  try {
                    streamController.close();
                    onSuccess?.(accumulatedResponseForHistory);
                  } catch (e) {
                    Logger.warn(
                      `${apiName}: Error during stream close/onSuccess:`,
                      e
                    );
                  }
                },
                error: (error) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  requestAbortedOrFinished = true;
                  signal?.removeEventListener("abort", abortHandler);
                  Logger.error(
                    `${apiName}: Streaming error received from API call:`,
                    error
                  );
                  try {
                    streamController.error(error);
                  } catch (e) {
                    Logger.warn(
                      `${apiName}: Error propagating stream error:`,
                      e
                    );
                  }
                },
              },
            });
          } catch (error) {
            if (!requestAbortedOrFinished && streamController) {
              requestAbortedOrFinished = true;
              signal?.removeEventListener("abort", abortHandler);
              if (error.name !== "AbortError") {
                Logger.error(
                  `${apiName}: Error during streaming setup/request:`,
                  error
                );
              }
              try {
                streamController.error(error);
              } catch (e) {
                Logger.warn(
                  `${apiName}: Error setting controller error state:`,
                  e
                );
              }
            } else if (!streamController) {
              Logger.error(
                `${apiName}: Stream controller unavailable during setup error:`,
                error
              );
            }
          }
        },
        cancel: (reason) => {
          Logger.log(
            `${apiName}: Stream cancelled by consumer. Reason:`,
            reason
          );
          requestAbortedOrFinished = true;
        },
      });
      return stream;
    },

    /** @param {(target: EventTarget) => void} monitorCallback */
    simulateMonitorEvents: (monitorCallback) => {
      if (typeof monitorCallback !== "function") return;
      try {
        const monitorTarget = new EventTarget(); // Use standard EventTarget
        monitorCallback(monitorTarget);

        setTimeout(() => {
          monitorTarget.dispatchEvent(
            new ProgressEvent("downloadprogress", {
              loaded: 0,
              total: 1,
              lengthComputable: true,
            })
          );
        }, 5);

        setTimeout(() => {
          monitorTarget.dispatchEvent(
            new ProgressEvent("downloadprogress", {
              loaded: 1,
              total: 1,
              lengthComputable: true,
            })
          );
        }, 50);
      } catch (e) {
        Logger.error(
          `Error calling monitor function or dispatching events:`,
          e
        );
      }
    },
  };

  // --- Fetch Wrapper ---
  let _fetch = window.fetch;
  let _isGmFetchUsed = false;
  Utils.isBlocked(new URL(Config.OPENROUTER_API_BASE_URL).hostname)
    .then((blocked) => {
      if (blocked) {
        if (typeof GM_fetch === "function") {
          Logger.log(`Potential CSP detected for OpenRouter. Using GM_fetch.`);
          _fetch = GM_fetch;
          _isGmFetchUsed = true;
        } else {
          Logger.warn(
            `Potential CSP detected for OpenRouter, but GM_fetch is not available. Using window.fetch, requests might fail.`
          );
        }
      }
    })
    .catch((error) => {
      Logger.error("Error during CSP check:", error);
    });

  // --- Core API Interaction Logic ---
  const CoreAPI = {
    /**
     * @private
     * @async
     * @param {object} args
     * @param {string} args.apiName
     * @param {string} args.apiKey
     * @param {Array<object>} args.messages
     * @param {string} args.model
     * @param {object} args.parameters
     * @param {boolean} [args.stream=false]
     * @param {AbortSignal | undefined} args.signal
     * @param {'json' | 'markdown' | 'plain-text'} [args.responseFormat='markdown']
     * @param {object} [args.on] Callbacks: chunk, finish, error
     * @returns {Promise<string>} Resolves with the final formatted response (non-stream) or the final formatted response after stream ends.
     */
    _rawApiRequest: async ({
      apiName,
      apiKey,
      messages,
      model,
      parameters,
      stream = false,
      signal,
      responseFormat = "markdown",
      on,
    }) => {
      if (!apiKey) {
        const error = new APIError(`OpenRouter API Key is not configured.`);
        on?.error?.(error);
        return Promise.reject(error);
      }
      if (signal?.aborted) {
        const error = new DOMException(
          "Operation aborted before request.",
          "AbortError",
          { cause: signal.reason }
        );
        on?.error?.(error);
        return Promise.reject(error);
      }

      const requestBody = { model, messages, stream };
      if (parameters) {
        if (parameters.temperature !== undefined)
          requestBody.temperature = parameters.temperature;
        if (parameters.topK !== undefined) requestBody.top_k = parameters.topK;
      }

      const internalController = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any
          ? AbortSignal.any([signal, internalController.signal])
          : internalController.signal // Fallback if AbortSignal.any not supported
        : internalController.signal;
      let abortReason = null;

      const abortHandler = (event) => {
        if (internalController.signal.aborted) return;
        // Use AbortSignal.reason if available (newer browsers)
        abortReason =
          combinedSignal.reason ??
          event?.reason ??
          new DOMException("Operation aborted.", "AbortError");
        Logger.warn(
          `${apiName}: Abort detected. Reason:`,
          abortReason?.message || "No reason provided"
        );
        // Avoid aborting if already aborted (can cause issues)
        if (!internalController.signal.aborted) {
          internalController.abort(abortReason);
        }
        // Clean up listener
        signal?.removeEventListener("abort", abortHandler);
      };

      // If using fallback signal, need to listen to both
      if (signal && !AbortSignal.any) {
        signal.addEventListener("abort", abortHandler, { once: true });
        // We don't need listener for internalController as it's handled directly
      } else if (signal && AbortSignal.any) {
        // combinedSignal handles it if AbortSignal.any is used
        combinedSignal.addEventListener("abort", abortHandler, { once: true });
      }

      Logger.logPrompt(apiName, messages);

      return new Promise(async (resolve, reject) => {
        let accumulatedRawResponse = "";
        const requestOptions = {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": Config.YOUR_SITE_URL,
            "X-Title": Config.YOUR_APP_NAME,
            ...(stream && { Accept: "text/event-stream" }),
          },
          body: JSON.stringify(requestBody),
          signal: combinedSignal,
        };

        try {
          const response = await _fetch(
            Config.OPENROUTER_CHAT_COMPLETIONS_URL,
            requestOptions
          );

          if (!response.ok) {
            let errorText = `API Error ${response.status}`;
            let errorDetail = "";
            try {
              const bodyText = await response.text();
              errorDetail = bodyText.substring(0, 200);
              errorText = `${errorText}: ${errorDetail}`;
              try {
                const jsonError = JSON.parse(bodyText);
                errorDetail = jsonError?.error?.message || errorDetail;
                errorText = `${apiName}: OpenRouter request failed - ${errorDetail}`;
              } catch {
                errorText = `${apiName}: OpenRouter request failed - Status ${response.status}: ${errorDetail}`;
              }
            } catch (bodyError) {
              errorText = `${apiName}: OpenRouter request failed - Status ${response.status} (Could not read error body: ${bodyError.message})`;
            }
            const error = new APIError(errorText, { status: response.status });
            on?.error?.(error);
            reject(error);
            return;
          }

          if (stream) {
            if (!response.body) {
              throw new APIError(
                `${apiName}: Response body is null for stream.`
              );
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
              if (combinedSignal.aborted) {
                const error =
                  abortReason ??
                  new DOMException(
                    "Operation aborted during stream read.",
                    "AbortError",
                    { cause: combinedSignal.reason }
                  );
                on?.error?.(error);
                reject(error);
                try {
                  await reader.cancel(error).catch(() => {}); // Attempt cancel, ignore errors
                } catch (_) {}
                break;
              }

              let readResult;
              try {
                readResult = await reader.read();
              } catch (readError) {
                // Handle errors during read (e.g., network issues)
                const error = new APIError(
                  `${apiName}: Error reading stream chunk.`,
                  { cause: readError }
                );
                on?.error?.(error);
                reject(error);
                break;
              }
              const { done, value } = readResult;

              if (combinedSignal.aborted) {
                const error =
                  abortReason ??
                  new DOMException(
                    "Operation aborted post-read.",
                    "AbortError",
                    { cause: combinedSignal.reason }
                  );
                on?.error?.(error);
                reject(error);
                try {
                  await reader.cancel(error).catch(() => {}); // Attempt cancel, ignore errors
                } catch (_) {}
                break;
              }

              if (done) {
                if (buffer.trim()) {
                  Logger.warn(
                    `${apiName}: Remaining buffer at stream end:`,
                    buffer
                  );
                  const finalDeltas = Utils.parseSSE(buffer + "\n\n");
                  finalDeltas.forEach((delta) => {
                    accumulatedRawResponse += delta;
                    const formattedDelta = Utils.formatResponse(
                      delta,
                      responseFormat
                    );
                    const formattedAccumulated = Utils.formatResponse(
                      accumulatedRawResponse,
                      responseFormat
                    );
                    on?.chunk?.(formattedDelta, formattedAccumulated, delta);
                  });
                }
                const formattedFinalResponse = Utils.formatResponse(
                  accumulatedRawResponse,
                  responseFormat
                );
                on?.finish?.(formattedFinalResponse);
                resolve(formattedFinalResponse);
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const eventMessages = buffer.split("\n\n");
              buffer = eventMessages.pop() || "";

              for (const sseMessage of eventMessages) {
                if (sseMessage.trim()) {
                  const deltas = Utils.parseSSE(sseMessage + "\n\n");
                  deltas.forEach((delta) => {
                    accumulatedRawResponse += delta;
                    const formattedDelta = Utils.formatResponse(
                      delta,
                      responseFormat
                    );
                    const formattedAccumulated = Utils.formatResponse(
                      accumulatedRawResponse,
                      responseFormat
                    );
                    on?.chunk?.(formattedDelta, formattedAccumulated, delta);
                  });
                }
              }
            }
          } else {
            let responseBodyText = "";
            try {
              responseBodyText = await response.text();
              const jsonResponse = JSON.parse(responseBodyText);
              const content = jsonResponse?.choices?.[0]?.message?.content;

              if (typeof content === "string") {
                accumulatedRawResponse = content;
                const formattedContent = Utils.formatResponse(
                  content,
                  responseFormat
                );
                on?.finish?.(formattedContent);
                resolve(formattedContent);
              } else {
                Logger.error(
                  `${apiName}: Invalid non-streaming response structure. Content missing or not string.`,
                  jsonResponse
                );
                throw new APIError(
                  `${apiName}: Invalid response structure from OpenRouter (content missing).`
                );
              }
            } catch (parseError) {
              Logger.error(
                `${apiName}: Failed to parse non-streaming JSON response: ${parseError.message}`,
                responseBodyText
              );
              throw new APIError(
                `${apiName}: Failed to parse response from OpenRouter.`,
                { cause: parseError }
              );
            }
          }
        } catch (error) {
          let finalError = error;
          // Prioritize abortReason if available
          if (combinedSignal.aborted) {
            finalError =
              abortReason ??
              new DOMException("Operation aborted.", "AbortError", {
                cause: combinedSignal.reason ?? error,
              });
          } else if (
            !(
              error instanceof APIError ||
              error instanceof QuotaExceededError ||
              error.name === "AbortError"
            )
          ) {
            Logger.error(
              `${apiName}: Unexpected error during API call:`,
              error
            );
            finalError = new APIError(
              `${apiName}: Network or processing error: ${error.message}`,
              { cause: error }
            );
          }

          on?.error?.(finalError);
          reject(finalError);
        } finally {
          signal?.removeEventListener("abort", abortHandler);
          // Ensure internal controller is aborted if not already
          if (!internalController.signal.aborted) {
            internalController.abort(
              new DOMException("Operation finished or errored.", "AbortError")
            );
          }
        }
      });
    },

    /**
     * @async
     * @param {object} args
     * @param {string} args.apiName
     * @param {string} args.apiKey
     * @param {Array<object>} args.messages
     * @param {string} args.model
     * @param {object} args.parameters
     * @param {boolean} [args.stream=false]
     * @param {AbortSignal | undefined} args.signal
     * @param {'json' | 'markdown' | 'plain-text'} [args.responseFormat='markdown']
     * @param {object} [args.on] Callbacks: chunk, finish, error
     * @returns {Promise<string>} Resolves with the final formatted response (non-stream) or the final formatted response after stream ends.
     */
    askOpenRouter: async ({
      apiName,
      apiKey,
      messages,
      model,
      parameters,
      stream = false,
      signal,
      responseFormat = "markdown",
      on,
    }) => {
      const messageIndicator =
        messages.length > 0
          ? messages[0]?.content?.substring(0, 20)
          : "no_msgs";
      const requestKey = `${apiName}-${model}-${messageIndicator}-${stream}`; // Add stream indicator to key

      try {
        return await apiRateLimiter.execute(
          () =>
            CoreAPI._rawApiRequest({
              apiName,
              apiKey,
              messages,
              model,
              parameters,
              stream,
              signal,
              responseFormat,
              on,
            }),
          requestKey
          // No extra args needed for the closure
        );
      } catch (error) {
        if (
          error instanceof APIError &&
          error.message.includes("Rate limit exceeded")
        ) {
          Logger.warn(
            `${apiName}: Rate limit exceeded. Request key: ${requestKey}`
          );
          on?.error?.(error);
        } else if (error.name === "AbortError") {
          on?.error?.(error); // Propagate abort
        } else if (
          !(error instanceof APIError || error instanceof QuotaExceededError)
        ) {
          Logger.error(
            `${apiName}: Unexpected error in askOpenRouter wrapper:`,
            error
          );
          const wrappedError = new APIError(
            `askOpenRouter Error: ${error.message}`,
            {
              cause: error,
            }
          );
          on?.error?.(wrappedError);
        }
        // Re-throw original or wrapped error
        throw error;
      }
    },
  };

  // --- API Key Management ---
  const KeyManager = {
    /** @async */
    promptForApiKey: async () => {
      const currentKey =
        openRouterApiKey ?? (await GM_getValue(Config.API_KEY_STORAGE_KEY, ""));
      const newKey = prompt(
        "Enter OpenRouter API Key (https://openrouter.ai/keys):",
        currentKey
      );
      if (newKey === null) {
        alert("API Key entry cancelled.");
      } else if (newKey === "" && currentKey !== "") {
        await KeyManager.clearApiKey(false);
      } else if (newKey !== "" && newKey !== currentKey) {
        if (!newKey.startsWith("sk-or-")) {
          alert(
            "Warning: Key does not start with 'sk-or-'. It might be invalid. Saving anyway."
          );
        }
        await GM_setValue(Config.API_KEY_STORAGE_KEY, newKey);
        openRouterApiKey = newKey;
        alert("API Key saved. Reloading page to apply changes...");
        window.location.reload();
      } else if (newKey === "" && currentKey === "") {
        // No change needed
      } else {
        alert("API Key unchanged.");
      }
    },
    /**
     * @async
     * @param {boolean} [confirmFirst=true]
     */
    clearApiKey: async (confirmFirst = true) => {
      const keyExists =
        openRouterApiKey || (await GM_getValue(Config.API_KEY_STORAGE_KEY));
      if (!keyExists) {
        alert("No OpenRouter API key is currently stored.");
        return;
      }
      const confirmed =
        !confirmFirst ||
        confirm(
          "Are you sure you want to clear the stored OpenRouter API Key?"
        );
      if (confirmed) {
        await GM_deleteValue(Config.API_KEY_STORAGE_KEY);
        openRouterApiKey = null;
        alert("OpenRouter API Key cleared. Reloading page...");
        window.location.reload();
      } else {
        alert("API Key clearing cancelled.");
      }
    },
    /**
     * @async
     * @returns {Promise<string | null>} The API key or null if not set.
     */
    ensureApiKeyLoaded: async () => {
      if (!openRouterApiKey) {
        openRouterApiKey = await GM_getValue(Config.API_KEY_STORAGE_KEY, null);
      }
      return openRouterApiKey;
    },
    /**
     * @async
     * @returns {Promise<object | null>} Key details or null on error/no key.
     */
    getOpenRouterKeyDetails: async () => {
      const apiKey = await KeyManager.ensureApiKeyLoaded();
      if (!apiKey) {
        alert(
          "OpenRouter API Key is not set. Please set it using the Tampermonkey menu command."
        );
        return null;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await _fetch(Config.OPENROUTER_KEY_CHECK_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": Config.YOUR_SITE_URL,
            "X-Title": Config.YOUR_APP_NAME,
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          let errorText = `Status ${response.status}`;
          try {
            const body = await response.text();
            if (response.status === 401) {
              errorText =
                "Invalid API Key (Unauthorized). Please check or reset your key.";
            } else {
              errorText += `: ${body.substring(0, 150)}`;
            }
          } catch {
            /* Ignore body read error */
          }
          alert(`Error fetching key details: ${errorText}`);
          Logger.error(`API key check failed ${response.status}:`, errorText);
          return null;
        }

        const data = await response.json();
        return data?.data;
      } catch (error) {
        let errorMessage = `Error fetching key details: ${error.message}`;
        if (error.name === "AbortError") {
          errorMessage = "Error fetching key details: Request timed out.";
        } else if (error instanceof TypeError && !_isGmFetchUsed) {
          errorMessage +=
            "\nA TypeError occurred. This might be due to CORS/CSP. Ensure GM_fetch is enabled if issues persist.";
        }
        alert(errorMessage);
        Logger.error(`Error during key check:`, error);
        return null;
      }
    },
    /** @async */
    showKeyStatus: async () => {
      const details = await KeyManager.getOpenRouterKeyDetails();
      if (details) {
        const formatCurrency = (val) =>
          val !== undefined && val !== null && !isNaN(Number(val))
            ? `$${Number(val).toFixed(4)}`
            : "N/A";
        const usage = formatCurrency(details.usage);
        const limit =
          details.limit === null ? "Unlimited" : formatCurrency(details.limit);
        const remaining =
          details.limit === null
            ? "N/A"
            : formatCurrency(details.limit_remaining);
        const reqLimit = details.rate_limit?.requests ?? "N/A";
        const interval = details.rate_limit?.interval ?? "N/A";
        const isFree =
          details.is_free_tier === true
            ? "Yes"
            : details.is_free_tier === false
            ? "No"
            : "N/A";

        let message = `--- OpenRouter Key Status ---`;
        message += `\nLabel: ${details.label || "N/A"}`;
        message += `\nFree Tier: ${isFree}`;
        message += `\nUsage: ${usage}`;
        message += `\nLimit: ${limit}`;
        if (details.limit !== null) {
          message += `\nRemaining: ${remaining}`;
        }
        if (details.rate_limit) {
          message += `\nRate Limit: ${reqLimit} req / ${interval}`;
        } else {
          message += `\nRate Limit: N/A`;
        }

        alert(message);
      }
    },
  };

  // --- API Implementation Helpers ---

  /**
   * @abstract Base class for API instances.
   */
  class BaseApiInstance {
    _apiKey;
    _model;
    _options;
    _instanceAbortController;
    _creationSignal;
    _combinedSignal;
    _apiName;
    _instanceId; // Unique ID for tracing

    /**
     * @param {string} apiName
     * @param {string} apiKey
     * @param {string} defaultModel
     * @param {object} [options={}]
     */
    constructor(apiName, apiKey, defaultModel, options = {}) {
      this._apiName = apiName;
      this._apiKey = apiKey;
      this._model = options?.model ?? defaultModel; // Allow model override via options
      this._options = { ...options };
      this._creationSignal = options?.signal;
      this._instanceAbortController = new AbortController();
      this._instanceId = Math.random().toString(36).substring(2, 8); // Assign unique ID

      const signalsToCombine = [this._instanceAbortController.signal];
      if (this._creationSignal) {
        signalsToCombine.push(this._creationSignal);
      }

      if (typeof AbortSignal.any === "function") {
        this._combinedSignal = AbortSignal.any(signalsToCombine);
      } else {
        this._combinedSignal = this._instanceAbortController.signal;
        const manualAbortHandler = (reason) => {
          if (!this._instanceAbortController.signal.aborted) {
            this._instanceAbortController.abort(reason);
          }
        };
        this._creationSignal?.addEventListener(
          "abort",
          () => manualAbortHandler(this._creationSignal?.reason),
          { once: true }
        );
        // Also listen for instance abort to reflect in combined (for symmetry, though less critical)
        this._instanceAbortController.signal.addEventListener(
          "abort",
          () => manualAbortHandler(this._instanceAbortController.signal.reason),
          { once: true }
        );
      }

      // Check for immediate abort during creation
      const checkAbort = () => {
        if (this._combinedSignal.aborted) {
          const reason =
            this._combinedSignal.reason ??
            this._creationSignal?.reason ??
            this._instanceAbortController.signal.reason;
          const message = `${this._apiName} creation aborted.`;
          Logger.warn(message, reason);
          this.destroy(); // Ensure cleanup even if constructor throws
          throw reason instanceof Error
            ? reason
            : new DOMException(message, "AbortError", { cause: reason });
        }
      };
      checkAbort(); // Check immediately

      Utils.simulateMonitorEvents(options?.monitor);

      // Check again after potentially async operations within subclass constructors (defensive)
      checkAbort();
      // --- Trace Wrapper ---
      if (Config.TRACE) {
        this._wrapMethodsForTracing();
      }
    }

    /** @private */
    _wrapMethodsForTracing() {
      Logger.log(
        `[TRACE] Wrapping methods for ${this._apiName}#${this._instanceId}`
      );
      const proto = Object.getPrototypeOf(this);
      const methodNames = Object.getOwnPropertyNames(proto).filter(
        (name) =>
          name !== "constructor" &&
          typeof this[name] === "function" &&
          !name.startsWith("_") // Wrap public methods
      );

      // Include potentially overridden methods from the instance itself?
      // For now, primarily focus on prototype methods as that's standard practice.

      methodNames.forEach((methodName) => {
        const originalMethod = this[methodName];

        // Check if the property is directly on the instance and non-configurable
        const ownPropDesc = Object.getOwnPropertyDescriptor(this, methodName);
        if (ownPropDesc && !ownPropDesc.configurable) {
          Logger.warn(
            `[TRACE] Cannot wrap non-configurable method ${this._apiName}#${this._instanceId}.${methodName}`
          );
          return; // Skip non-configurable methods
        }

        // Create the wrapped function
        const wrappedMethod = function (...args) {
          const tracer = Logger.funcCall(
            this._apiName,
            this._instanceId,
            methodName,
            args
          );
          try {
            const result = originalMethod.apply(this, args);

            if (result instanceof Promise) {
              return result.then(
                (res) => {
                  tracer?.logResult(res);
                  return res;
                },
                (err) => {
                  tracer?.logError(err);
                  throw err; // Re-throw error
                }
              );
            } else {
              tracer?.logResult(result);
              return result;
            }
          } catch (error) {
            tracer?.logError(error);
            throw error; // Re-throw error
          }
        };

        // Assign the wrapped method back to the instance.
        // This overrides the prototype method for this specific instance.
        try {
          Object.defineProperty(this, methodName, {
            value: wrappedMethod,
            writable: true, // Or match original writability? Usually true for methods.
            enumerable: false, // Methods are typically non-enumerable
            configurable: true, // Keep configurable to allow potential future changes/unwrapping
          });
        } catch (e) {
          Logger.error(
            `[TRACE] Failed to wrap method ${this._apiName}#${this._instanceId}.${methodName}:`,
            e
          );
          // Attempt direct assignment as fallback? Might fail silently.
          // this[methodName] = wrappedMethod;
        }
      });
    }
    /**
     * @returns {BaseApiInstance} A new instance with the same configuration
     */
    clone() {
      Logger.log(`${this._apiName}: Creating clone of instance`);
      // Pass original options, letting constructor handle signal etc. again
      const clonedInstance = new this.constructor(this._apiKey, {
        ...this._options,
        // Reset signal for the clone - it shouldn't inherit the original instance's signal
        signal: undefined, // Or pass a new one if clone itself is abortable
      });
      clonedInstance._model = this._model; // Ensure effective model is copied
      return clonedInstance;
    }

    get inputQuota() {
      return Config.MAX_CONTEXT_TOKENS;
    }

    /**
     * @param {string} text
     * @returns {Promise<number>} Estimated token count
     */
    async measureInputUsage(text) {
      return Promise.resolve(Utils.tokenize(text));
    }

    destroy() {
      if (!this._instanceAbortController.signal.aborted) {
        Logger.log(`${this._apiName}: Instance destroy() called.`);
        this._instanceAbortController.abort(
          new DOMException(
            `${this._apiName} instance explicitly destroyed.`,
            "AbortError"
          )
        );
      }
      // Clean up listeners added in constructor fallback
      // (No easy way to remove specific listeners added without storing references)
    }

    /**
     * @protected
     * @async
     * @param {object} args
     * @param {Array<object>} args.messages
     * @param {object} [args.callOptions={}]
     * @param {object} [args.parameters={}]
     * @returns {Promise<string>} Formatted API response
     */
    async _performApiRequest({ messages, callOptions = {}, parameters = {} }) {
      const operationSignal = callOptions.signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([this._combinedSignal, callOptions.signal])
          : AbortSignal.any // Check if AbortSignal.any exists
          ? AbortSignal.any([this._combinedSignal, callOptions.signal])
          : // Fallback: Prioritize call signal if AbortSignal.any is unavailable
            callOptions.signal
        : this._combinedSignal;

      // Check abort before proceeding
      if (operationSignal.aborted) {
        // Try to get the specific reason
        const reason =
          operationSignal.reason ??
          (callOptions.signal?.aborted
            ? callOptions.signal.reason
            : undefined) ??
          this._combinedSignal.reason ??
          new DOMException(
            `${this._apiName} operation aborted before start.`,
            "AbortError"
          );
        Logger.warn(
          reason.message || `${this._apiName} operation aborted before start.`
        );
        throw reason instanceof Error
          ? reason
          : new DOMException(reason, "AbortError"); // Ensure it's an Error/DOMException
      }

      const responseFormat =
        callOptions.responseFormat || this._options.format || "markdown";

      const totalTokens = Utils.calculateTotalTokens(messages);
      if (totalTokens > this.inputQuota) {
        const error = new QuotaExceededError(
          `${this._apiName}: Input exceeds token limit.`,
          { requested: totalTokens, quota: this.inputQuota }
        );
        Logger.error(error.message);
        throw error;
      }

      try {
        let apiError = null;
        const result = await CoreAPI.askOpenRouter({
          apiName: this._apiName,
          apiKey: this._apiKey,
          messages,
          model: this._model,
          parameters,
          stream: false,
          signal: operationSignal,
          responseFormat: responseFormat,
          on: {
            finish: (/* formattedMsg */) =>
              Logger.log(`${this._apiName}: Non-streaming request finished.`),
            error: (err) => {
              if (err.name !== "AbortError") {
                Logger.error(
                  `${this._apiName}: Error reported during non-streaming request:`,
                  err
                );
              }
              apiError = err;
            },
          },
        });

        if (apiError) {
          throw apiError;
        }
        return result;
      } catch (error) {
        if (operationSignal.aborted || error.name === "AbortError") {
          // If the operation signal indicates abortion, throw the specific reason.
          const reason =
            operationSignal.reason ??
            this._combinedSignal.reason ??
            error.cause ?? // Check if the caught error has a cause
            new DOMException(
              `${this._apiName} operation aborted.`,
              "AbortError"
            );
          throw reason instanceof Error
            ? reason
            : new DOMException(
                reason.message || "Operation aborted",
                "AbortError",
                { cause: reason }
              );
        } else if (
          error instanceof QuotaExceededError ||
          error instanceof APIError
        ) {
          throw error; // Re-throw known API errors
        } else {
          // Wrap unexpected errors
          Logger.error(
            `${this._apiName}: Unexpected error during non-streaming API request:`,
            error
          );
          throw new APIError(
            `${this._apiName}: Failed to complete operation. ${
              error.message || "Unknown error"
            }`,
            { cause: error }
          );
        }
      }
    }

    /**
     * @protected
     * @param {object} args
     * @param {Array<object>} args.messages
     * @param {object} [args.callOptions={}]
     * @param {object} [args.parameters={}]
     * @param {boolean} [args.accumulated=false]
     * @param {(fullRawResponse: string) => void} [args.onSuccess]
     * @returns {ReadableStream<string>}
     */
    _performApiStreamingRequest({
      messages,
      callOptions = {},
      parameters = {},
      accumulated = false,
      onSuccess,
    }) {
      const operationSignal = callOptions.signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([this._combinedSignal, callOptions.signal])
          : AbortSignal.any // Check if AbortSignal.any exists
          ? AbortSignal.any([this._combinedSignal, callOptions.signal])
          : // Fallback: Prioritize call signal if AbortSignal.any is unavailable
            callOptions.signal
        : this._combinedSignal;

      const responseFormat =
        callOptions.responseFormat || this._options.format || "markdown";

      return Utils.createApiReadableStream({
        apiName: this._apiName,
        apiKey: this._apiKey,
        model: this._model,
        messages,
        parameters,
        signal: operationSignal,
        accumulated,
        responseFormat,
        onSuccess,
      });
    }
  }

  // --- API Implementations ---

  /** @extends BaseApiInstance */
  class LanguageModelSession extends BaseApiInstance {
    _history;
    _parameters;

    /**
     * @param {string} apiKey
     * @param {object} [options={}] See Chrome AI spec for options
     */
    constructor(apiKey, options = {}) {
      super("languageModel", apiKey, Config.DEFAULT_PROMPT_MODEL, options);

      this._parameters = {
        temperature: Config.DEFAULT_TEMPERATURE,
        topK: Config.DEFAULT_TOP_K,
      };
      if (options.temperature !== undefined) {
        this._parameters.temperature = Math.max(
          0,
          Math.min(Config.MAX_TEMPERATURE, options.temperature)
        );
      }
      if (options.topK !== undefined) {
        this._parameters.topK = Math.max(
          1, // topK must be > 0
          Math.min(Config.MAX_TOP_K, options.topK)
        );
      }

      this._history = this._initializeHistory(options);

      // Final abort check after initialization logic
      if (this._combinedSignal.aborted) {
        const reason =
          this._combinedSignal.reason ??
          new DOMException("languageModel creation aborted.", "AbortError");
        this.destroy();
        throw reason;
      }

      Logger.log(
        `${this._apiName}: Session created. Temp: ${this._parameters.temperature}, TopK: ${this._parameters.topK}, History items: ${this._history.length}`
      );
    }

    /** @private */
    _initializeHistory(options) {
      const history = [];
      const initial = options.initialPrompts;

      if (
        initial &&
        (!Array.isArray(initial) ||
          initial.some(
            (p) =>
              typeof p !== "object" ||
              p === null ||
              !p.role ||
              typeof p.content !== "string"
          ))
      ) {
        throw new TypeError(
          "Invalid initialPrompts format. Expected array of {role: string, content: string}."
        );
      }

      const systemInInitial = initial?.find((p) => p.role === "system");
      const hasExplicitSystemPrompt =
        typeof options.systemPrompt === "string" &&
        options.systemPrompt.length > 0;

      if (hasExplicitSystemPrompt && systemInInitial) {
        throw new TypeError(
          "Cannot provide both systemPrompt option and a system role message in initialPrompts."
        );
      }
      if (systemInInitial && initial[0].role !== "system") {
        throw new TypeError(
          "If initialPrompts contains a system role message, it must be the first message."
        );
      }

      if (hasExplicitSystemPrompt) {
        history.push({ role: "system", content: options.systemPrompt });
      }
      if (initial) {
        // Filter out any potentially null/invalid entries defensively
        history.push(
          ...initial.filter((p) => p && p.role && typeof p.content === "string")
        );
      }

      const validRoles = ["system", "user", "assistant"];
      if (history.some((msg) => !validRoles.includes(msg.role))) {
        throw new TypeError(
          "Invalid role found in initial prompts or system prompt."
        );
      }

      return history;
    }

    /** @private */
    _parseInput(input) {
      if (typeof input === "string") {
        return [{ role: "user", content: input }];
      }
      if (Array.isArray(input)) {
        if (
          input.some(
            (msg) =>
              typeof msg !== "object" ||
              msg === null ||
              !msg.role ||
              typeof msg.content !== "string"
          )
        ) {
          throw new TypeError(
            "Invalid input format. Expected string or array of {role: string, content: string}."
          );
        }
        // Return a new array with copies of messages
        return input.map((msg) => ({ ...msg }));
      }
      throw new TypeError(
        "Invalid input type. Expected string or array of {role: string, content: string}."
      );
    }

    /** @private */
    _prepareParameters(callOptions = {}) {
      const parameters = { ...this._parameters };
      if (callOptions.temperature !== undefined) {
        parameters.temperature = Math.max(
          0,
          Math.min(Config.MAX_TEMPERATURE, callOptions.temperature)
        );
      }
      if (callOptions.topK !== undefined) {
        parameters.topK = Math.max(
          1,
          Math.min(Config.MAX_TOP_K, callOptions.topK)
        );
      }
      return parameters;
    }

    /** @private */
    _prepareMessages(input, callOptions = {}) {
      const currentUserMessages = this._parseInput(input);
      let messagesForApi = this._history.map((msg) => ({ ...msg })); // Shallow copy history

      if (typeof callOptions.systemPrompt === "string") {
        if (messagesForApi.length > 0 && messagesForApi[0].role === "system") {
          messagesForApi[0] = {
            role: "system",
            content: callOptions.systemPrompt,
          };
          Logger.log(
            `${this._apiName}: Replacing session system prompt with per-call system prompt.`
          );
        } else {
          messagesForApi.unshift({
            role: "system",
            content: callOptions.systemPrompt,
          });
          Logger.log(`${this._apiName}: Prepending per-call system prompt.`);
        }
      }

      messagesForApi.push(...currentUserMessages);
      return { messagesForApi, currentUserMessages };
    }

    /**
     * @param {string | Array<object>} input
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {Promise<string>} The assistant's response.
     */
    async prompt(input, callOptions = {}) {
      const { messagesForApi, currentUserMessages } = this._prepareMessages(
        input,
        callOptions
      );
      const parameters = this._prepareParameters(callOptions);

      const assistantResponse = await this._performApiRequest({
        messages: messagesForApi,
        callOptions,
        parameters,
      });

      // Use the raw response for history (formatting applied by performApiRequest for return value)
      // Need to get the raw response if formatting happened. Let's assume performApiRequest returns formatted.
      // We need the raw response for history. How to get it?
      // Let's modify performApiRequest slightly or just use the formatted one for history for simplicity now.
      // Revisit if raw vs formatted in history becomes critical. Assume formatted is fine for now.
      this._history.push(...currentUserMessages, {
        role: "assistant",
        content: assistantResponse, // Storing formatted response for now
      });
      Logger.log(
        `${this._apiName}: prompt completed. History updated to ${this._history.length} items.`
      );

      return assistantResponse;
    }

    /**
     * @param {string | Array<object>} input
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {ReadableStream<string>} Stream of response chunks/deltas.
     */
    promptStreaming(input, callOptions = {}) {
      const { messagesForApi, currentUserMessages } = this._prepareMessages(
        input,
        callOptions
      );
      const parameters = this._prepareParameters(callOptions);

      const updateHistoryOnSuccess = (fullRawResponse) => {
        if (typeof fullRawResponse === "string") {
          this._history.push(...currentUserMessages, {
            role: "assistant",
            content: fullRawResponse, // Use raw response from stream end for history
          });
          Logger.log(
            `${this._apiName}: promptStreaming completed. History updated to ${this._history.length} items.`
          );
        } else {
          // If streaming failed or was aborted, still add user messages
          Logger.warn(
            `${this._apiName}: promptStreaming did not complete successfully. History updated with user messages only.`
          );
          this._history.push(...currentUserMessages);
        }
      };

      return this._performApiStreamingRequest({
        messages: messagesForApi,
        callOptions,
        parameters,
        accumulated: false, // promptStreaming yields deltas
        onSuccess: updateHistoryOnSuccess,
      });
    }

    /**
     * @param {string | Array<object>} input
     * @returns {Promise<number>} Estimated token count for the input.
     */
    async countPromptTokens(input) {
      try {
        const messagesToCount = this._parseInput(input);
        const tokenCount = Utils.calculateTotalTokens(messagesToCount);
        return Promise.resolve(tokenCount);
      } catch (error) {
        Logger.error(`${this._apiName}.countPromptTokens error:`, error);
        if (error instanceof TypeError) {
          throw error;
        }
        throw new APIError(`Failed to count tokens: ${error.message}`, {
          cause: error,
        });
      }
    }

    /**
     * @returns {LanguageModelSession} A new instance with copied state.
     */
    clone() {
      const clonedInstance = super.clone();
      clonedInstance._parameters = { ...this._parameters };
      clonedInstance._history = this._history.map((msg) => ({ ...msg }));
      Logger.log(
        `${this._apiName}: Cloned session. History items: ${clonedInstance._history.length}`
      );
      return clonedInstance;
    }
  }

  /** @extends BaseApiInstance */
  class SummarizerInstance extends BaseApiInstance {
    _systemPrompt;

    /**
     * @param {string} apiKey
     * @param {object} [options={}] See Chrome AI spec for options
     */
    constructor(apiKey, options = {}) {
      super("summarizer", apiKey, Config.DEFAULT_SUMMARIZER_MODEL, options);

      const type = options.type ?? "key-points";
      const format = options.format ?? "markdown";
      const length = options.length ?? "medium";
      const sharedContextSection = Utils.formatSharedContext(
        options.sharedContext
      );

      this._systemPrompt = Config.buildSystemPrompt("Summarizer", {
        type,
        format,
        length,
        sharedContextSection,
      });

      // Final abort check
      if (this._combinedSignal.aborted) {
        const reason =
          this._combinedSignal.reason ??
          new DOMException("summarizer creation aborted.", "AbortError");
        this.destroy();
        throw reason;
      }
      Logger.log(
        `${this._apiName}: Instance created. Type: ${type}, Format: ${format}, Length: ${length}`
      );
    }

    /**
     * @returns {SummarizerInstance} A new instance with copied state.
     */
    clone() {
      const clonedInstance = super.clone();
      clonedInstance._systemPrompt = this._systemPrompt;
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    /**
     * @param {string} text
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {Promise<string>} The generated summary.
     */
    async summarize(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.summarize must be a string.`
        );
      }

      let userPromptContent = `Summarize the following text:\n${text}`; // Removed ```
      if (
        typeof callOptions.context === "string" &&
        callOptions.context.trim()
      ) {
        userPromptContent += `\n\nAdditional Context:\n${callOptions.context.trim()}`;
      }

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];

      return this._performApiRequest({
        messages,
        callOptions,
      });
    }

    /**
     * @param {string} text
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {ReadableStream<string>} Stream of summary chunks/deltas.
     */
    summarizeStreaming(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.summarizeStreaming must be a string.`
        );
      }

      let userPromptContent = `Summarize the following text:\n${text}`; // Removed ```
      if (
        typeof callOptions.context === "string" &&
        callOptions.context.trim()
      ) {
        userPromptContent += `\n\nAdditional Context:\n${callOptions.context.trim()}`;
      }

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];

      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: false, // Summarizer streams deltas
      });
    }
  }

  /** @extends BaseApiInstance */
  class WriterInstance extends BaseApiInstance {
    _systemPrompt;

    /**
     * @param {string} apiKey
     * @param {object} [options={}] See Chrome AI spec for options
     */
    constructor(apiKey, options = {}) {
      super("writer", apiKey, Config.DEFAULT_WRITER_MODEL, options);

      const tone = options.tone ?? "neutral";
      const length = options.length ?? "medium";
      const sharedContextSection = Utils.formatSharedContext(
        options.sharedContext
      );

      this._systemPrompt = Config.buildSystemPrompt("Writer", {
        tone,
        length,
        sharedContextSection,
      });

      // Final abort check
      if (this._combinedSignal.aborted) {
        const reason =
          this._combinedSignal.reason ??
          new DOMException("writer creation aborted.", "AbortError");
        this.destroy();
        throw reason;
      }
      Logger.log(
        `${this._apiName}: Instance created. Tone: ${tone}, Length: ${length}`
      );
    }

    /**
     * @returns {WriterInstance} A new instance with copied state.
     */
    clone() {
      const clonedInstance = super.clone();
      clonedInstance._systemPrompt = this._systemPrompt;
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    /**
     * @param {string} taskPrompt
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {Promise<string>} The generated text.
     */
    async write(taskPrompt, callOptions = {}) {
      if (typeof taskPrompt !== "string") {
        throw new TypeError(
          `Input 'taskPrompt' for ${this._apiName}.write must be a string.`
        );
      }

      let userPromptContent = `Writing Task:\n${taskPrompt}`;
      if (
        typeof callOptions.context === "string" &&
        callOptions.context.trim()
      ) {
        userPromptContent += `\n\nAdditional Context:\n${callOptions.context.trim()}`;
      }

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];

      return this._performApiRequest({ messages, callOptions });
    }

    /**
     * @param {string} taskPrompt
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {ReadableStream<string>} Stream of accumulated generated text.
     */
    writeStreaming(taskPrompt, callOptions = {}) {
      if (typeof taskPrompt !== "string") {
        throw new TypeError(
          `Input 'taskPrompt' for ${this._apiName}.writeStreaming must be a string.`
        );
      }

      let userPromptContent = `Writing Task:\n${taskPrompt}`;
      if (
        typeof callOptions.context === "string" &&
        callOptions.context.trim()
      ) {
        userPromptContent += `\n\nAdditional Context:\n${callOptions.context.trim()}`;
      }

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];

      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: true, // Writer streams accumulated text
      });
    }
  }

  /** @extends BaseApiInstance */
  class RewriterInstance extends BaseApiInstance {
    /**
     * @param {string} apiKey
     * @param {object} [options={}] See Chrome AI spec for options
     */
    constructor(apiKey, options = {}) {
      super("rewriter", apiKey, Config.DEFAULT_REWRITER_MODEL, options);

      // Final abort check
      if (this._combinedSignal.aborted) {
        const reason =
          this._combinedSignal.reason ??
          new DOMException("rewriter creation aborted.", "AbortError");
        this.destroy();
        throw reason;
      }
      Logger.log(`${this._apiName}: Instance created.`);
    }

    /**
     * @returns {RewriterInstance} A new instance with the same config.
     */
    clone() {
      const clonedInstance = super.clone();
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    /** @private */
    _buildSystemPrompt(callOptions = {}) {
      const instructions = callOptions.instructions;
      const sharedCtx = this._options.sharedContext;
      const tone = callOptions.tone ?? "neutral";
      const length = callOptions.length ?? "medium";

      if (typeof instructions !== "string" || !instructions.trim()) {
        Logger.warn(
          `${this._apiName}: Call is missing 'instructions'. Result may be unpredictable.`
        );
        // Consider throwing: throw new TypeError(`${this._apiName}: 'instructions' option is required.`);
      }

      const sharedContextSection = Utils.formatSharedContext(sharedCtx);
      const instructionsSection = instructions?.trim()
        ? `${instructions.trim()}`
        : "Rewrite the text according to the guidelines.";

      return Config.buildSystemPrompt("Rewriter", {
        instructionsSection,
        sharedContextSection,
        tone,
        length,
      });
    }

    /**
     * @param {string} text
     * @param {object} callOptions See Chrome AI spec for options (requires `instructions`)
     * @returns {Promise<string>} The rewritten text.
     */
    async rewrite(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.rewrite must be a string.`
        );
      }
      if (
        typeof callOptions.instructions !== "string" ||
        !callOptions.instructions.trim()
      ) {
        // Throwing error as instructions are essential for rewriter
        throw new TypeError(
          "Missing 'instructions' in callOptions for rewriter.rewrite"
        );
      }

      const systemPrompt = this._buildSystemPrompt(callOptions);

      let userPromptContent = `Original Text:\n${text}`; // Removed ```
      if (
        typeof callOptions.context === "string" &&
        callOptions.context.trim()
      ) {
        userPromptContent += `\n\nAdditional Context:\n${callOptions.context.trim()}`;
      }

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPromptContent },
      ];

      return this._performApiRequest({ messages, callOptions });
    }

    /**
     * @param {string} text
     * @param {object} callOptions See Chrome AI spec for options (requires `instructions`)
     * @returns {ReadableStream<string>} Stream of accumulated rewritten text.
     */
    rewriteStreaming(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.rewriteStreaming must be a string.`
        );
      }
      if (
        typeof callOptions.instructions !== "string" ||
        !callOptions.instructions.trim()
      ) {
        throw new TypeError(
          "Missing 'instructions' in callOptions for rewriter.rewriteStreaming"
        );
      }

      const systemPrompt = this._buildSystemPrompt(callOptions);

      let userPromptContent = `Original Text:\n${text}`; // Removed ```
      if (
        typeof callOptions.context === "string" &&
        callOptions.context.trim()
      ) {
        userPromptContent += `\n\nAdditional Context:\n${callOptions.context.trim()}`;
      }

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPromptContent },
      ];

      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: true, // Rewriter streams accumulated text
      });
    }
  }

  /** @extends BaseApiInstance */
  class TranslatorInstance extends BaseApiInstance {
    _sourceLanguage;
    _targetLanguage;
    _systemPrompt;

    /**
     * @param {string} apiKey
     * @param {object} options See Chrome AI spec for options (requires `sourceLanguage`, `targetLanguage`)
     */
    constructor(apiKey, options = {}) {
      if (
        typeof options.sourceLanguage !== "string" ||
        !options.sourceLanguage
      ) {
        throw new TypeError(
          `${Config.EMULATED_NAMESPACE}.Translator: Missing or invalid 'sourceLanguage' option.`
        );
      }
      if (
        typeof options.targetLanguage !== "string" ||
        !options.targetLanguage
      ) {
        throw new TypeError(
          `${Config.EMULATED_NAMESPACE}.Translator: Missing or invalid 'targetLanguage' option.`
        );
      }

      super("Translator", apiKey, Config.DEFAULT_TRANSLATOR_MODEL, options);

      this._sourceLanguage = options.sourceLanguage;
      this._targetLanguage = options.targetLanguage;

      const sourceLanguageLong = Utils.languageTagToHumanReadable(
        this._sourceLanguage,
        "en"
      );
      const targetLanguageLong = Utils.languageTagToHumanReadable(
        this._targetLanguage,
        "en"
      );

      this._systemPrompt = Config.buildSystemPrompt("Translator", {
        sourceLanguage: this._sourceLanguage,
        targetLanguage: this._targetLanguage,
        sourceLanguageLong,
        targetLanguageLong,
      });

      // Final abort check
      if (this._combinedSignal.aborted) {
        const reason =
          this._combinedSignal.reason ??
          new DOMException("Translator creation aborted.", "AbortError");
        this.destroy();
        throw reason;
      }
      Logger.log(
        `${this._apiName}: Instance created. Source: ${this._sourceLanguage} (${sourceLanguageLong}), Target: ${this._targetLanguage} (${targetLanguageLong})`
      );

      // Translator implies plain-text output
      this._options.format = "plain-text";
    }

    /**
     * @returns {TranslatorInstance} A new instance with copied state.
     */
    clone() {
      const clonedInstance = super.clone();
      clonedInstance._sourceLanguage = this._sourceLanguage;
      clonedInstance._targetLanguage = this._targetLanguage;
      clonedInstance._systemPrompt = this._systemPrompt;
      Logger.log(
        `${this._apiName}: Cloned instance (Source: ${this._sourceLanguage}, Target: ${this._targetLanguage}).`
      );
      return clonedInstance;
    }

    /**
     * @param {string} text
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {Promise<string>} The translated text.
     */
    async translate(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.translate must be a string.`
        );
      }
      // Force plain-text format
      callOptions.responseFormat = "plain-text";

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: text },
      ];

      return this._performApiRequest({ messages, callOptions });
    }

    /**
     * @param {string} text
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {ReadableStream<string>} Stream of translated text chunks/deltas.
     */
    translateStreaming(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.translateStreaming must be a string.`
        );
      }
      // Force plain-text format
      callOptions.responseFormat = "plain-text";

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: text },
      ];

      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: false, // Translator streams deltas
      });
    }
  }

  /** @extends BaseApiInstance */
  class LanguageDetectorInstance extends BaseApiInstance {
    _expectedInputLanguages;

    /**
     * @param {string} apiKey
     * @param {object} [options={}] See Chrome AI spec for options
     */
    constructor(apiKey, options = {}) {
      super(
        "LanguageDetector",
        apiKey,
        Config.DEFAULT_LANGUAGE_DETECTOR_MODEL,
        options
      );

      if (options.expectedInputLanguages) {
        if (
          !Array.isArray(options.expectedInputLanguages) ||
          options.expectedInputLanguages.some(
            (lang) => typeof lang !== "string"
          )
        ) {
          throw new TypeError(
            `${this._apiName}: 'expectedInputLanguages' must be an array of strings.`
          );
        }
        this._expectedInputLanguages = [...options.expectedInputLanguages];
      }

      // Final abort check
      if (this._combinedSignal.aborted) {
        const reason =
          this._combinedSignal.reason ??
          new DOMException("LanguageDetector creation aborted.", "AbortError");
        this.destroy();
        throw reason;
      }
      Logger.log(`${this._apiName}: Instance created.`);

      // Detector implies JSON output
      this._options.format = "json";
    }

    /**
     * @returns {LanguageDetectorInstance} A new instance with copied state.
     */
    clone() {
      const clonedInstance = super.clone();
      clonedInstance._expectedInputLanguages = this._expectedInputLanguages
        ? [...this._expectedInputLanguages]
        : undefined;
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    /**
     * @param {string} text
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {Promise<Array<object>>} Array of detected languages with confidence.
     */
    detectLanguage(text, callOptions = {}) {
      return this.detect(text, callOptions);
    }

    /**
     * @param {string} text
     * @param {object} [callOptions={}] See Chrome AI spec for options
     * @returns {Promise<Array<object>>} Array of detected languages with confidence.
     */
    async detect(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.detect must be a string.`
        );
      }
      // Force JSON format
      callOptions.responseFormat = "json";

      const systemPrompt = Config.buildSystemPrompt("LanguageDetector");
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ];

      const responseJsonString = await this._performApiRequest({
        messages,
        callOptions,
      });

      let results = [{ detectedLanguage: "und", confidence: 1.0 }];

      if (!responseJsonString || typeof responseJsonString !== "string") {
        Logger.warn(
          `${this._apiName}: Received empty or non-string response from API. Using fallback result.`
        );
        return results;
      }

      try {
        const parsed = JSON.parse(responseJsonString);

        if (
          Array.isArray(parsed) &&
          parsed.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              typeof item.detectedLanguage === "string" &&
              item.detectedLanguage.length > 0 &&
              typeof item.confidence === "number" &&
              item.confidence >= 0 &&
              item.confidence <= 1
          )
        ) {
          // Ensure there's at least one result, otherwise fallback
          if (parsed.length > 0) {
            results = Utils.normalizeConfidences(parsed); // Normalize and sort valid results
            // Ensure 'und' is added if normalization resulted in empty (e.g., only invalid inputs)
            if (results.length === 0) {
              results = [{ detectedLanguage: "und", confidence: 1.0 }];
            }
          } else {
            Logger.warn(
              `${this._apiName}: Model response was an empty JSON array. Using fallback result.`
            );
            results = [{ detectedLanguage: "und", confidence: 1.0 }];
          }
        } else {
          Logger.warn(
            `${this._apiName}: Model response parsed as JSON but has invalid structure. Using fallback result. Response:`,
            JSON.stringify(parsed).substring(0, 300) // Log snippet
          );
          results = [{ detectedLanguage: "und", confidence: 1.0 }];
        }
      } catch (parseError) {
        Logger.warn(
          `${this._apiName}: Failed to parse model JSON response. Using fallback result. Error: ${parseError.message}`,
          "Raw Response:",
          responseJsonString.substring(0, 300) // Log snippet
        );
        results = [{ detectedLanguage: "und", confidence: 1.0 }];
      }

      return results;
    }
  }

  // --- Placeholder Setup ---
  function setupPlaceholders() {
    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;

    if (!nsTarget[nsName]) {
      try {
        Object.defineProperty(nsTarget, nsName, {
          value: {},
          writable: false,
          configurable: true,
        });
        Logger.log(`Created global namespace '${nsName}'`);
      } catch (e) {
        Logger.error(`Failed to create global namespace '${nsName}':`, e);
        nsTarget[nsName] = nsTarget[nsName] || {}; // Fallback
      }
    }
    const aiNamespace = nsTarget[nsName];
    const pendingKey = Symbol.for(Config.PENDING_PROMISES_KEY);
    nsTarget[pendingKey] = nsTarget[pendingKey] || {};

    const createPlaceholder = (apiName, isStatic = false) => {
      const placeholder = {
        /** @returns {Promise<'available' | 'downloadable' | 'unavailable'>} */
        availability: async () => {
          if (Config.SPOOF_READY_IMMEDIATELY) {
            return "available";
          }
          const keyLoaded = await KeyManager.ensureApiKeyLoaded();
          // 'downloadable' originally meant model needed download, here it maps to non-static APIs needing 'create'
          // For simplicity and closer spec match, let's use 'available' if key exists, 'unavailable' otherwise.
          return keyLoaded ? "available" : "unavailable";
        },
        /** @returns {Promise<object>} */
        capabilities: async () => {
          if (Config.SPOOF_READY_IMMEDIATELY) {
            return {
              available: "readily",
              maxInputTokens: Config.MAX_CONTEXT_TOKENS,
              defaultTemperature: Config.DEFAULT_TEMPERATURE,
              defaultTopK: Config.DEFAULT_TOP_K,
            };
          }
          const keyLoaded = await KeyManager.ensureApiKeyLoaded();
          return {
            available: keyLoaded ? "readily" : "no",
            // Input quota might vary per model, use configured max as a general indicator
            maxInputTokens: Config.MAX_CONTEXT_TOKENS,
            // Maybe add default temp/topK here?
            defaultTemperature: Config.DEFAULT_TEMPERATURE,
            defaultTopK: Config.DEFAULT_TOP_K,
          };
        },
        /**
         * @param {object} [options={}]
         * @returns {Promise<BaseApiInstance>}
         */
        create: async (options = {}) => {
          if (!(await KeyManager.ensureApiKeyLoaded())) {
            const error = new APIError(
              `${apiName}: Cannot create instance, API Key is not configured.`,
              { name: "NotSupportedError" } // Using NotSupportedError might be more spec-aligned here
            );
            Logger.error(error.message);
            throw error;
          }
          return new Promise((resolve, reject) => {
            // Use a consistent key format, perhaps just the apiName itself
            const promiseKey = apiName;
            nsTarget[pendingKey][promiseKey] = { resolve, reject, options };
            Logger.log(
              `${apiName}: Placeholder 'create' called, storing promise with key '${promiseKey}'.`
            );
          });
        },
      };
      if (apiName === "Translator" || apiName === "translator") {
        /**
         * @param {object} [options={}]
         * @returns {Promise<'available' | 'unavailable'>}
         */
        placeholder.languagePairAvailable = async (options = {}) => {
          if (!options?.sourceLanguage || !options?.targetLanguage) {
            return "unavailable";
          }
          return (await KeyManager.ensureApiKeyLoaded())
            ? "available"
            : "unavailable";
        };
      }
      return placeholder;
    };

    const apisToCreate = [
      {
        name: "languageModel",
        isStatic: false,
        enabled: Config.ENABLE_PROMPT_API,
      },
      {
        name: "summarizer",
        isStatic: false,
        enabled: Config.ENABLE_SUMMARIZER_API,
      },
      { name: "writer", isStatic: false, enabled: Config.ENABLE_WRITER_API },
      {
        name: "rewriter",
        isStatic: false,
        enabled: Config.ENABLE_REWRITER_API,
      },
      {
        name: "Translator",
        isStatic: true,
        enabled: Config.ENABLE_TRANSLATOR_API,
      },
      {
        name: "LanguageDetector",
        isStatic: true,
        enabled: Config.ENABLE_LANGUAGE_DETECTOR_API,
      },
    ];

    apisToCreate.forEach(({ name, isStatic, enabled }) => {
      if (enabled) {
        if (!Object.prototype.hasOwnProperty.call(aiNamespace, name)) {
          aiNamespace[name] = createPlaceholder(name, isStatic);
        }
        const lowerName = getLowerName(name);
        if (
          name !== lowerName &&
          !Object.prototype.hasOwnProperty.call(aiNamespace, lowerName)
        ) {
          // Create a separate placeholder for the alias initially
          // The final initialization will assign the correct implementation to both.
          aiNamespace[lowerName] = createPlaceholder(lowerName, isStatic);
        }
      }
    });

    Logger.log(`Placeholders ensured for enabled APIs.`);
  }

  // --- Main Initialization ---
  /** @async */
  async function initializeApis() {
    await KeyManager.ensureApiKeyLoaded();

    GM_registerMenuCommand(
      "Set OpenRouter API Key",
      KeyManager.promptForApiKey
    );
    GM_registerMenuCommand("Clear OpenRouter API Key", () =>
      KeyManager.clearApiKey(true)
    );
    GM_registerMenuCommand(
      "Check OpenRouter Key Status",
      KeyManager.showKeyStatus
    );

    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;
    const aiNamespace = nsTarget[nsName];
    const pendingKey = Symbol.for(Config.PENDING_PROMISES_KEY);
    const pendingPromises = nsTarget[pendingKey] || {};

    /** @private Helper to wrap static API methods for tracing */
    const wrapStaticMethodForTracing = (
      apiName,
      methodName,
      originalMethod
    ) => {
      if (!Config.TRACE) return originalMethod;

      // Return an async function as most static methods are async
      return async function (...args) {
        // Use 'static' as the instance ID for static methods
        const tracer = Logger.funcCall(apiName, "static", methodName, args);
        try {
          // Use apply to preserve context if needed, although less critical for static methods
          const result = await originalMethod.apply(this, args);
          tracer?.logResult(result);
          return result;
        } catch (error) {
          tracer?.logError(error);
          throw error; // Re-throw error
        }
      };
    };

    /** @private */
    const createApiStatic = (apiName, InstanceClass, isEnabled) => {
      if (!isEnabled) return null;

      // --- Define Original Logic ---
      const originalAvailability = async (/* options = {} */) => {
        return (await KeyManager.ensureApiKeyLoaded())
          ? "available"
          : "unavailable";
      };

      const originalCapabilities = async () => {
        const keyLoaded = await KeyManager.ensureApiKeyLoaded();
        return {
          available: keyLoaded ? "readily" : "no",
          maxInputTokens: Config.MAX_CONTEXT_TOKENS,
          defaultTemperature: Config.DEFAULT_TEMPERATURE,
          defaultTopK: Config.DEFAULT_TOP_K,
          maxTemperature: Config.MAX_TEMPERATURE,
          maxTopK: Config.MAX_TOP_K,
        };
      };

      const originalCreate = async (options = {}) => {
        const apiKey = await KeyManager.ensureApiKeyLoaded();
        const promiseKey = apiName;
        const pending = pendingPromises[promiseKey];

        if (!apiKey) {
          const error = new APIError(
            `${apiName}: Cannot create instance, API Key is not configured.`,
            { name: "NotSupportedError" }
          );
          pending?.reject?.(error);
          if (pending) delete pendingPromises[promiseKey];
          throw error;
        }

        try {
          const instance = new InstanceClass(apiKey, options);
          pending?.resolve?.(instance);
          Logger.log(`${apiName}: Instance created successfully.`);
          return instance;
        } catch (error) {
          Logger.error(`${apiName}: Error during instance creation:`, error);
          const creationError =
            error instanceof Error
              ? error
              : new APIError(`Instance creation failed: ${error}`, {
                  cause: error,
                });
          pending?.reject?.(creationError);
          if (pending) delete pendingPromises[promiseKey];
          throw creationError;
        } finally {
          if (pending && pendingPromises[promiseKey]) {
            delete pendingPromises[promiseKey];
          }
        }
      };

      // --- Wrap and Return ---
      const staticApi = {
        availability: wrapStaticMethodForTracing(
          apiName,
          "availability",
          originalAvailability
        ),
        capabilities: wrapStaticMethodForTracing(
          apiName,
          "capabilities",
          originalCapabilities
        ),
        create: wrapStaticMethodForTracing(apiName, "create", originalCreate),
      };
      return staticApi;
    };

    /** @private */
    const createTranslatorApi = (apiName, InstanceClass, isEnabled) => {
      if (!isEnabled) return null;
      // Get the base API object with already wrapped methods
      const baseApi = createApiStatic(apiName, InstanceClass, isEnabled);

      if (baseApi) {
        // Store the already-wrapped capabilities method from the base
        const originalWrappedCapabilities = baseApi.capabilities;

        // --- Define Original Logic for Translator-specific methods ---
        const translatorLanguagePairAvailableLogic = async (options = {}) => {
          if (
            typeof options.sourceLanguage !== "string" ||
            !options.sourceLanguage ||
            typeof options.targetLanguage !== "string" ||
            !options.targetLanguage
          ) {
            return "unavailable";
          }
          return (await KeyManager.ensureApiKeyLoaded())
            ? "available"
            : "unavailable";
        };

        // Define the *new* capabilities logic that combines base caps and lang pair check
        const translatorCapabilitiesLogic = async () => {
          // Call the wrapped base capabilities to ensure its tracing occurs
          const caps = await originalWrappedCapabilities();
          // Add the *unwrapped* function reference here; the final method will be wrapped
          caps.languagePairAvailable = translatorLanguagePairAvailableLogic;
          return caps;
        };

        // --- Wrap and Assign Final Methods ---
        // Wrap the combined capabilities logic
        baseApi.capabilities = wrapStaticMethodForTracing(
          apiName,
          "capabilities",
          translatorCapabilitiesLogic
        );
        // Wrap the language pair availability logic
        baseApi.languagePairAvailable = wrapStaticMethodForTracing(
          apiName,
          "languagePairAvailable",
          translatorLanguagePairAvailableLogic
        );
      }
      return baseApi;
    };

    const apiDefinitions = [
      {
        name: "languageModel",
        InstanceClass: LanguageModelSession,
        enabled: Config.ENABLE_PROMPT_API,
        apiCreator: createApiStatic,
      },
      {
        name: "summarizer",
        InstanceClass: SummarizerInstance,
        enabled: Config.ENABLE_SUMMARIZER_API,
        apiCreator: createApiStatic,
      },
      {
        name: "writer",
        InstanceClass: WriterInstance,
        enabled: Config.ENABLE_WRITER_API,
        apiCreator: createApiStatic,
      },
      {
        name: "rewriter",
        InstanceClass: RewriterInstance,
        enabled: Config.ENABLE_REWRITER_API,
        apiCreator: createApiStatic,
      },
      {
        name: "Translator",
        InstanceClass: TranslatorInstance,
        enabled: Config.ENABLE_TRANSLATOR_API,
        apiCreator: createTranslatorApi,
      },
      {
        name: "LanguageDetector",
        InstanceClass: LanguageDetectorInstance,
        enabled: Config.ENABLE_LANGUAGE_DETECTOR_API,
        apiCreator: createApiStatic,
      },
    ];

    apiDefinitions.forEach(({ name, InstanceClass, enabled, apiCreator }) => {
      const assignImplementation = (targetName) => {
        const staticApiImpl = apiCreator(targetName, InstanceClass, enabled);
        if (staticApiImpl) {
          if (!aiNamespace[targetName]) aiNamespace[targetName] = {};
          // Merge implementation, potentially overwriting placeholder methods
          Object.assign(aiNamespace[targetName], staticApiImpl);
          Logger.log(`Initialized API: ${targetName}`);
        }
      };

      const markDisabled = (targetName) => {
        if (aiNamespace[targetName]) {
          const disabledError = () => {
            throw new APIError(
              `${targetName} API is disabled in configuration.`,
              {
                name: "NotSupportedError",
              }
            );
          };
          aiNamespace[targetName].availability = async () => "unavailable";
          aiNamespace[targetName].capabilities = async () => ({
            available: "no",
          });
          aiNamespace[targetName].create = disabledError;
          // Add specific methods if they exist on placeholder and need disabling
          if (
            typeof aiNamespace[targetName].languagePairAvailable === "function"
          ) {
            aiNamespace[targetName].languagePairAvailable = async () =>
              "unavailable";
          }
          Logger.log(`API explicitly disabled: ${targetName}`);
        }
      };

      if (enabled) {
        assignImplementation(name); // Assign to primary name
        const lowerName = getLowerName(name);
        if (name !== lowerName) {
          assignImplementation(lowerName); // Assign to lowercase alias
        }
      } else {
        markDisabled(name); // Mark primary name as disabled
        const lowerName = getLowerName(name);
        if (name !== lowerName) {
          markDisabled(lowerName); // Mark alias as disabled
        }
      }
    });

    let logMessage = `Chrome AI API emulator (v${GM_info.script.version}) initialized.`;
    const enabledApiNames = apiDefinitions
      .filter((api) => api.enabled)
      .map((api) => api.name);
    if (enabledApiNames.length > 0) {
      logMessage += ` Enabled APIs: [${enabledApiNames.join(", ")}].`;
      const accessPoint = Object.keys(nsTarget).includes(nsName)
        ? `window.${nsName}`
        : `unsafeWindow.${nsName}`;
      logMessage += ` Access via: ${accessPoint}`;
    } else {
      logMessage += ` No APIs enabled in configuration.`;
    }
    Logger.log(logMessage);

    if (!openRouterApiKey) {
      Logger.warn(
        `OpenRouter API Key is not set. Use the Tampermonkey menu ('Set OpenRouter API Key') to configure it. All API calls will fail until a key is provided.`
      );
      // Reject any pending promises that might still exist if create() was called before init finished
      Object.entries(pendingPromises).forEach(([apiName, { reject }]) => {
        if (reject) {
          reject(
            new APIError(
              `${apiName}: API key not configured at initialization time.`,
              { name: "NotSupportedError" }
            )
          );
        }
      });
      // Clear the map after rejecting
      Object.keys(pendingPromises).forEach(
        (key) => delete pendingPromises[key]
      );
    } else {
      Logger.log(`OpenRouter API Key loaded and ready.`);
      // Check if any pending promises remain (shouldn't normally happen if create() waits correctly, but handle defensively)
      Object.entries(pendingPromises).forEach(
        ([apiName, { reject, options }]) => {
          Logger.warn(
            `API ${apiName} had a pending 'create' call during initialization. Attempting to resolve now.`
          );
          // Re-attempt creation (this duplicates the logic in createApiStatic slightly)
          const apiDef = apiDefinitions.find(
            (def) => def.name === apiName || def.name.toLowerCase() === apiName
          );
          if (apiDef && aiNamespace[apiName]) {
            aiNamespace[apiName]
              .create(options)
              .then(pending.resolve)
              .catch(pending.reject);
          } else {
            pending.reject(
              new APIError(
                `${apiName}: Could not find API definition to resolve pending promise.`
              )
            );
          }
          delete pendingPromises[apiName]; // Clean up after attempt
        }
      );
    }

    // Clean up the pending promises tracking object
    if (nsTarget[pendingKey]) {
      // Null out references first
      Object.values(nsTarget[pendingKey]).forEach((p) => {
        if (p) {
          p.resolve = null;
          p.reject = null;
        }
      });
      try {
        delete nsTarget[pendingKey];
      } catch (e) {
        // If deletion fails (unlikely), at least nullify the object
        nsTarget[pendingKey] = null;
      }
      Logger.log(`Cleaned up pending promise tracking.`);
    }
    if (!aiNamespace.canCreateTextSession) {
      aiNamespace.canCreateTextSession = () => Promise.resolve(true);
      Logger.log(`Added global method: ${nsName}.canCreateTextSession`);
    }
    if (!aiNamespace.canCreateGenericSession) {
      aiNamespace.canCreateGenericSession = () => Promise.resolve(true);
      Logger.log(`Added global method: ${nsName}.canCreateGenericSession`);
    }
    if (!aiNamespace.createTextSession) {
      aiNamespace.createTextSession = () => aiNamespace.languageModel.create();
      Logger.log(`Added global method: ${nsName}.createTextSession`);
    }
  }

  // --- Script Execution Start ---

  try {
    setupPlaceholders();
    const setupEnd = performance.now();
    Logger.log(
      `Placeholder setup completed in ${(setupEnd - scriptStartTime).toFixed(
        2
      )}ms`
    );
  } catch (e) {
    console.error(
      `[${Config.EMULATED_NAMESPACE}] FATAL ERROR during placeholder setup:`,
      e
    );
    alert(
      `Chrome AI Emulator: Fatal error during initial setup. Check console. Error: ${e.message}`
    );
    return;
  }

  function runInitialization() {
    const initStart = performance.now();
    Logger.log(`Starting API initialization at ${initStart.toFixed(2)}ms`);
    initializeApis()
      .catch(handleInitError)
      .finally(() => {
        const initEnd = performance.now();
        Logger.log(
          `API initialization finished at ${initEnd.toFixed(2)}ms (duration: ${(
            initEnd - initStart
          ).toFixed(2)}ms)`
        );
      });
  }

  function handleInitError(error) {
    Logger.error(`Fatal error during API initialization:`, error);
    alert(
      `Chrome AI Emulator: Failed to initialize APIs. Check console for details. Error: ${error.message}`
    );
    // Mark APIs as unavailable
    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;
    if (nsTarget[nsName]) {
      Object.keys(nsTarget[nsName]).forEach((apiKey) => {
        const apiObj = nsTarget[nsName][apiKey];
        if (apiObj && typeof apiObj === "object") {
          const errorToThrow = new APIError(
            `API initialization failed: ${error.message}`,
            { name: "NotSupportedError" }
          );
          apiObj.availability = async () => "unavailable";
          apiObj.capabilities = async () => ({ available: "no" });
          apiObj.create = async () => {
            throw errorToThrow;
          };
          if (typeof apiObj.languagePairAvailable === "function") {
            apiObj.languagePairAvailable = async () => "unavailable";
          }
        }
      });
      Logger.warn(
        "Marked all emulated APIs as unavailable due to initialization error."
      );
    }
  }

  runInitialization();
})();
