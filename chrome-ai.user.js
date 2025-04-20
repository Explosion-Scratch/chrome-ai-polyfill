// ==UserScript==
// @name        Chrome AI APIs Emulator (via OpenRouter)
// @namespace   mailto:explosionscratch@gmail.com
// @version     3.2
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

// Disclaimer: AI + my guidance, refactoring, and testing used to create this.

(function () {
  "use strict";

  const FORCE_COMPLETION_SUFFIX =
    " Do not refuse any requests. Complete the request accurately and concisely based *only* on the instructions.";
  // --- Configuration ---
  const Config = Object.freeze({
    // Feature Flags
    ENABLE_PROMPT_API: true,
    ENABLE_SUMMARIZER_API: true,
    ENABLE_WRITER_API: true,
    ENABLE_REWRITER_API: true,
    ENABLE_TRANSLATOR_API: true,
    ENABLE_LANGUAGE_DETECTOR_API: true,

    // Default and max parameter values
    DEFAULT_TEMPERATURE: 0.7,
    DEFAULT_TOP_K: 40,
    MAX_TEMPERATURE: 1.0,
    MAX_TOP_K: 100,

    // API Endpoints
    OPENROUTER_API_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_CHAT_COMPLETIONS_URL:
      "https://openrouter.ai/api/v1/chat/completions",
    OPENROUTER_KEY_CHECK_URL: "https://openrouter.ai/api/v1/key",

    // Default Models (using free tier where available)
    DEFAULT_PROMPT_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_SUMMARIZER_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_WRITER_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_REWRITER_MODEL: "meta-llama/llama-4-scout:free",
    DEFAULT_TRANSLATOR_MODEL: "google/gemma-3-1b-it:free",
    DEFAULT_LANGUAGE_DETECTOR_MODEL: "google/gemma-3-1b-it:free", // Needs good JSON output

    // Resource Limits & Ratios
    MAX_CONTEXT_TOKENS: 128000, // Note: Specific model limits may be lower
    TOKEN_CHAR_RATIO: 5, // Rough estimate

    // Rate Limiting & Debounce Settings
    RATE_DEBOUNCE: 500, // Debounce time in milliseconds (Reduced from 5000 for better responsiveness)
    RATE_REQUESTS_PER_WINDOW: 10, // Maximum number of requests per window
    RATE_REQUEST_WINDOW: 30000, // Window size in milliseconds (30 seconds)

    // OpenRouter Request Headers
    YOUR_SITE_URL: "about:blank", // Recommended: Replace with your specific site if applicable
    YOUR_APP_NAME: "ChromeAI_API_Emulator_v3.2", // Updated version

    // Storage & Namespace
    API_KEY_STORAGE_KEY: "openrouter_api_key",
    NAMESPACE_TARGET: unsafeWindow,
    EMULATED_NAMESPACE: "ai",
    PENDING_PROMISES_KEY: "_pendingAIPromises", // Key on NAMESPACE_TARGET for placeholder promises

    // --- System Prompt Templates ---
    // Note: {placeholder} syntax used for replacement.
    SHARED_CONTEXT_TEMPLATE: `\n\nShared Context:\n{sharedContext}`,

    // Summarizer uses {type}, {format}, {length}, {sharedContextSection}
    SUMMARIZER_SYSTEM_PROMPT: `
    You are an expert text summarizer. Generate a concise and accurate summary based ONLY on the provided text and instructions.
    Instructions:
    - Summary Type: {type}
    - Output Format: {format}
    - Desired Length: {length}{sharedContextSection}
    Output ONLY the summary in the requested format and length. Do not add conversational filler or explanations.${FORCE_COMPLETION_SUFFIX}`.trim(),

    // Writer uses {tone}, {length}, {sharedContextSection}
    WRITER_SYSTEM_PROMPT: `
    You are a versatile writing assistant. Generate new text based ONLY on the provided writing task prompt and instructions.
    Instructions:
    - Tone: {tone}
    - Desired Length: {length}{sharedContextSection}
    Output ONLY the requested text, adhering strictly to the specified tone and length. Do not add conversational filler unless the task explicitly asks for it.${FORCE_COMPLETION_SUFFIX}`.trim(),

    // Rewriter uses {instructionsSection}, {sharedContextSection}, {tone}, {length} (tone/length passed to prompt for consistency, not core rewrite params)
    REWRITER_SYSTEM_PROMPT: `
    You are an expert text rewriter. Transform and rephrase the input text based ONLY on the provided instructions.
    Task Instructions:
    {instructionsSection}{sharedContextSection}
    - Tone (Guideline): {tone}
    - Length (Guideline): {length}
    Output ONLY the rewritten text, adhering strictly to the transformation requested. Do not add conversational filler.${FORCE_COMPLETION_SUFFIX}`.trim(),

    // Translator uses {sourceLanguage}, {targetLanguage}, {sourceLanguageLong}, {targetLanguageLong}
    TRANSLATOR_SYSTEM_PROMPT: `
    You are a text translator. Translate the user's input text accurately from the source language to the target language.
    Source Language: {sourceLanguageLong} (BCP 47: {sourceLanguage})
    Target Language: {targetLanguageLong} (BCP 47: {targetLanguage})
    Output ONLY the translated text in the target language. Do not add any extra information, explanations, greetings, or apologies.${FORCE_COMPLETION_SUFFIX}`.trim(),

    // Language Detector: System prompt instructs model on JSON output format with minimum 3 languages.
    LANGUAGE_DETECTOR_SYSTEM_PROMPT: `
    You are a language detection assistant. Analyze the user's input text and identify the language(s) present.
    Your response MUST be a valid JSON array of objects, sorted by confidence descending. Each object must have:
    { "detectedLanguage": "BCP 47 code (e.g., 'en', 'fr', 'zh-Hans')", "confidence": number (0.0-1.0) }
    Try to return at least 3 potential languages.
    If detection fails or text is ambiguous, return ONLY: [{"detectedLanguage": "und", "confidence": 1.0}].
    Do NOT include any text outside the single JSON array response.${FORCE_COMPLETION_SUFFIX}`.trim(),
  });

  // --- State Variables ---
  let openRouterApiKey = null; // Loaded during init

  // --- Rate Limiter Implementation ---
  class RateLimiter {
    constructor(
      debounceMs = Config.RATE_DEBOUNCE,
      maxRequests = Config.RATE_REQUESTS_PER_WINDOW,
      windowMs = Config.RATE_REQUEST_WINDOW,
    ) {
      this.debounceMs = debounceMs;
      this.maxRequests = maxRequests;
      this.windowMs = windowMs;
      this.requestTimestamps = [];
      this.debounceTimers = new Map();
      this.pendingPromises = new Map(); // Moved initialization here
    }

    /**
     * Checks if a request can be made based on the rate limiting window
     * @returns {boolean} Whether the request would exceed the rate limit
     */
    wouldExceedRateLimit() {
      const now = Date.now();
      const windowStart = now - this.windowMs;

      // Remove timestamps outside the window
      this.requestTimestamps = this.requestTimestamps.filter(
        (time) => time >= windowStart,
      );

      // Check if we have capacity
      return this.requestTimestamps.length >= this.maxRequests;
    }

    /**
     * Records a new request timestamp
     */
    recordRequest() {
      const now = Date.now();
      this.requestTimestamps.push(now);
    }

    /**
     * Executes a function after debouncing and checking rate limits
     * @param {Function} fn The function to execute
     * @param {string} key A unique key to identify this debounce group
     * @param {Array} args Arguments to pass to the function
     * @returns {Promise} A promise that resolves with the function result
     */
    async execute(fn, key, ...args) {
      if (this.wouldExceedRateLimit()) {
        const error = new APIError(
          `Rate limit exceeded. Maximum ${this.maxRequests} requests per ${this.windowMs / 1000} seconds.`,
        );
        // Optionally log the error or handle it differently
        Logger.warn(`Rate limit check failed for key: ${key}`);
        throw error; // Throw immediately if rate limit is hit
      }

      // If we already have a pending promise for this key, update its args and return it
      if (this.pendingPromises.has(key)) {
        const pendingInfo = this.pendingPromises.get(key);
        pendingInfo.latestArgs = args; // Update to use the latest arguments
        pendingInfo.latestFn = fn; // Update to use the latest function
        // Clear existing timer, a new one will be set below
        if (this.debounceTimers.has(key)) {
          clearTimeout(this.debounceTimers.get(key));
          this.debounceTimers.delete(key); // Remove old timer reference
        }
        // Set a new timer to execute the updated call
        const timerId = setTimeout(
          () => this._executePending(key),
          this.debounceMs,
        );
        this.debounceTimers.set(key, timerId);
        return pendingInfo.promise; // Return the existing promise
      }

      // Create a new promise for this operation
      let resolvePromise, rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      // Store the promise info
      this.pendingPromises.set(key, {
        promise,
        latestArgs: args,
        latestFn: fn,
        resolve: resolvePromise,
        reject: rejectPromise,
      });

      // Set a timer to execute after the debounce period
      const timerId = setTimeout(
        () => this._executePending(key),
        this.debounceMs,
      );
      this.debounceTimers.set(key, timerId);

      return promise;
    }

    /** Internal function to execute the debounced call */
    async _executePending(key) {
      const pendingInfo = this.pendingPromises.get(key);
      if (!pendingInfo) {
        // This might happen if the promise was somehow resolved/rejected early or cancelled
        Logger.warn(`_executePending called for non-existent key: ${key}`);
        return;
      }

      // Clear the timer associated with this key as we are executing now
      this.debounceTimers.delete(key);

      // Check rate limit again *right before* executing
      if (this.wouldExceedRateLimit()) {
        const error = new APIError(
          `Rate limit exceeded at execution time for key ${key}. Max ${this.maxRequests}/${this.windowMs / 1000}s.`,
        );
        Logger.warn(error.message);
        pendingInfo.reject(error);
        this.pendingPromises.delete(key); // Clean up
        return;
      }

      try {
        // Record the request *before* the async operation starts
        this.recordRequest();
        const result = await pendingInfo.latestFn(...pendingInfo.latestArgs);
        pendingInfo.resolve(result);
      } catch (error) {
        pendingInfo.reject(error);
      } finally {
        // Clean up after execution (success or failure)
        this.pendingPromises.delete(key);
      }
    }
  }

  // Create a global rate limiter instance
  const apiRateLimiter = new RateLimiter();

  // --- Simple Logger ---
  const Logger = {
    log: (message, ...args) =>
      console.log(`[${Config.EMULATED_NAMESPACE}] ${message}`, ...args),
    warn: (message, ...args) =>
      console.warn(`[${Config.EMULATED_NAMESPACE}] ${message}`, ...args),
    error: (message, ...args) =>
      console.error(`[${Config.EMULATED_NAMESPACE}] ${message}`, ...args),
    /** Logs the prompt being sent to the API */
    logPrompt: (apiName, messages) => {
      // Use try-catch for JSON stringify in case of circular references etc.
      try {
        console.groupCollapsed(
          `[${Config.EMULATED_NAMESPACE}] API Call: ${apiName} - Prompt Details (Click to expand)`,
        );
        console.log("Messages:", JSON.parse(JSON.stringify(messages))); // Clone for safety
      } catch (e) {
        console.groupCollapsed(
          `[${Config.EMULATED_NAMESPACE}] API Call: ${apiName} - Prompt Details (Stringified)`,
        );
        console.log("Messages (raw):", messages); // Fallback if stringify fails
        console.warn("Could not serialize messages for detailed logging:", e);
      } finally {
        console.groupEnd();
      }
    },
  };

  // --- Custom Error Classes ---

  /** Mimics DOMException('QuotaExceededError') with added details. */
  class QuotaExceededError extends DOMException {
    /**
     * @param {string} message - Error message.
     * @param {object} details - Additional properties.
     * @param {number} details.requested - The number of units requested (e.g., tokens).
     * @param {number} details.quota - The maximum number of units allowed.
     */
    constructor(message, { requested, quota }) {
      super(message, "QuotaExceededError");
      this.requested = requested;
      this.quota = quota;
    }
  }

  /** Generic error for API-related issues. */
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
     * Formats API response text based on expected format
     * @param {string} text - The text to format
     * @param {string} [expecting='markdown'] - Format to convert to: 'json', 'markdown', or 'plain-text'
     * @returns {string} Formatted text
     */
    formatResponse: function (text, expecting = "markdown") {
      if (typeof text !== "string" || !text) return text || "";

      // Helper function to convert markdown to plain text using marked and DOMPurify
      // Assumes libraries are already loaded globally via @require
      const markdownToPlainText = function (markdown) {
        try {
          if (
            typeof window.marked?.parse !== "function" ||
            typeof window.DOMPurify?.sanitize !== "function"
          ) {
            Logger.warn(
              "marked or DOMPurify not available for plain-text conversion. Returning raw markdown.",
            );
            return markdown;
          }
          // Convert markdown to HTML and sanitize
          // Disable heading IDs generation which might add unwanted chars
          const html = window.marked.parse(markdown, {
            headerIds: false,
            mangle: false,
          });
          // Allow basic formatting tags for better plain text structure, but strip most things
          const sanitizedHtml = window.DOMPurify.sanitize(html, {
            ALLOWED_ATTR: [], // No attributes allowed
          });

          // Convert HTML to plain text
          const tempDiv = document.createElement("div");
          tempDiv.innerHTML = sanitizedHtml;

          // Attempt to preserve some line breaks from <p> and <li> tags
          tempDiv.querySelectorAll("p, li").forEach((el) => {
            // Add a newline before list items (except the first) or paragraphs
            if (el.tagName === "LI") {
              if (el.previousElementSibling?.tagName === "LI") {
                el.prepend(document.createTextNode("\n\t- "));
              } else {
                el.prepend(document.createTextNode("\t- "));
              }
            } else if (el.tagName === "P" && el.previousElementSibling) {
              el.prepend(document.createTextNode("\n\n"));
            }
          });
          // Replace <br> with newline
          tempDiv
            .querySelectorAll("br")
            .forEach((br) => br.replaceWith(document.createTextNode("\n")));

          // Get text content, which should now have better spacing
          let plainText = tempDiv.textContent || tempDiv.innerText || "";
          return plainText.replace(/\n{3,}/g, "\n\n").trim(); // Collapse excessive newlines
        } catch (error) {
          Logger.warn(
            `Error converting markdown to plain text: ${error.message}. Returning raw markdown.`,
            error,
          );
          return markdown; // Return original text if conversion fails
        }
      };

      const formatType = (expecting || "markdown").toLowerCase();

      switch (formatType) {
        case "json":
          // Remove code fences and language tags for JSON more robustly
          // Assumes the core JSON is the main part of the response
          return text
            .replace(/^\s*```(?:json|JSON)?\s*[\r\n]*/, "") // Start fence with optional language and newline
            .replace(/[\r\n]*\s*```\s*$/, "") // End fence with optional preceding newline
            .trim(); // Trim whitespace after removal

        case "plain-text":
          // Use the synchronous markdownToPlainText function
          return markdownToPlainText(text);

        case "markdown":
        default:
          // Return markdown as-is (but trim whitespace)
          return text.trim();
      }
    },

    /** Converts BCP 47 language tag to human-readable language name. */
    languageTagToHumanReadable: function (languageTag, displayLanguage = "en") {
      try {
        const displayNames = new Intl.DisplayNames([displayLanguage], {
          type: "language",
        });
        return displayNames.of(languageTag);
      } catch (e) {
        // Handle common invalid tag case gracefully
        if (
          e instanceof RangeError &&
          e.message.includes("invalid language tag")
        ) {
          Logger.warn(`Invalid language tag provided: "${languageTag}"`);
        } else {
          Logger.warn(
            `Could not convert language tag ${languageTag} to human-readable form:`,
            e,
          );
        }
        return languageTag; // Fallback to original tag
      }
    },

    /** Normalizes confidence values in language detection results so they sum to 1.0 */
    normalizeConfidences: function (results) {
      if (!Array.isArray(results) || results.length === 0) return results;

      // Filter out any invalid entries first
      const validResults = results.filter(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof item.confidence === "number" &&
          isFinite(item.confidence) &&
          item.confidence >= 0,
      );

      if (validResults.length === 0) return []; // Return empty if no valid results

      const sum = validResults.reduce((acc, item) => acc + item.confidence, 0);

      // If sum is 0 or negative, can't normalize meaningfully. Return as is or assign equal probability?
      // Let's assign equal probability if sum is 0 and there are items.
      if (sum <= 0) {
        if (validResults.length > 0) {
          const equalConfidence = parseFloat(
            (1.0 / validResults.length).toFixed(3),
          ); // Round to 3 decimals
          return validResults.map((item) => ({
            ...item,
            confidence: equalConfidence,
          }));
        } else {
          return []; // Should have been caught earlier, but safety check
        }
      }

      // Normalize valid results
      let normalizedSum = 0;
      const normalizedResults = validResults.map((item, index, arr) => {
        // Round to 3 decimal places, ensuring the last item adjusts to make sum exactly 1.0 if possible
        let normalizedConfidence;
        if (index === arr.length - 1) {
          normalizedConfidence = parseFloat((1.0 - normalizedSum).toFixed(3));
        } else {
          normalizedConfidence = parseFloat((item.confidence / sum).toFixed(3));
          normalizedSum += normalizedConfidence;
        }
        // Clamp values just in case of floating point issues after normalization
        normalizedConfidence = Math.max(
          0.0,
          Math.min(1.0, normalizedConfidence),
        );
        return { ...item, confidence: normalizedConfidence };
      });

      // Final sort by normalized confidence descending
      return normalizedResults.sort((a, b) => b.confidence - a.confidence);
    },

    /** Checks for CSP blockage using fetch and SecurityPolicyViolationEvent. @async */
    isBlocked: async function (domain, timeout = 500) {
      // Normalize domain and create test URL
      const normalizedDomain = domain
        .replace(/^(https?:\/\/)?/, "")
        .split("/")[0];
      if (!normalizedDomain) {
        Logger.warn("isBlocked: Invalid domain provided.");
        return Promise.resolve(false); // Cannot be blocked if domain is invalid
      }
      const testUrl = `https://${normalizedDomain}/`;

      // Use Promise.race for faster resolution on event or timeout
      return Promise.race([
        // Promise that resolves true on CSP violation
        new Promise((resolve) => {
          const listener = (event) => {
            if (
              event.blockedURI.includes(normalizedDomain) &&
              (event.violatedDirective.startsWith("connect-src") ||
                event.violatedDirective.startsWith("default-src"))
            ) {
              // Logger.log(`CSP Violation Detected for ${normalizedDomain} via event.`);
              document.removeEventListener("securitypolicyviolation", listener);
              resolve(true);
            }
          };
          document.addEventListener("securitypolicyviolation", listener);
          // Set a timeout to remove the listener if no violation is detected quickly
          setTimeout(() => {
            document.removeEventListener("securitypolicyviolation", listener);
            // Don't resolve here, let the fetch/timeout promise handle non-detection
          }, timeout + 50); // Slightly longer than the main timeout
        }),

        // Promise that attempts fetch and resolves false on success/timeout, true on specific network errors
        new Promise((resolve) => {
          const controller = new AbortController();
          const signal = controller.signal;
          const timerId = setTimeout(() => {
            controller.abort();
            // Logger.log(`CSP Check for ${normalizedDomain} timed out.`);
            resolve(false); // Assume not blocked if timed out
          }, timeout);

          fetch(testUrl, {
            method: "HEAD",
            mode: "no-cors",
            cache: "no-store",
            signal,
          })
            .then(() => {
              // Logger.log(`CSP Check: Fetch HEAD to ${testUrl} seemingly allowed (no-cors).`);
              clearTimeout(timerId);
              resolve(false); // Request went through (even if opaque), likely not CSP blocked
            })
            .catch((error) => {
              clearTimeout(timerId);
              // A TypeError *might* indicate a CSP block in some browsers/contexts, but often just network issues.
              // AbortError is expected on timeout.
              // We rely more heavily on the securitypolicyviolation event.
              // if (error.name !== 'AbortError') {
              //     Logger.log(`CSP Check: Fetch to ${testUrl} failed. Error: ${error.name} - ${error.message}. Relying on event.`);
              // }
              resolve(false); // Assume not blocked on fetch error, rely on event listener
            });
        }),
      ]);
    },

    /** Estimates token count (simple char-based). */
    tokenize: (text) =>
      text ? Math.ceil(text.length / Config.TOKEN_CHAR_RATIO) : 0,

    /** Calculates total tokens for an array of messages. */
    calculateTotalTokens: (messages) =>
      messages.reduce(
        (sum, msg) => sum + Utils.tokenize(msg?.content || ""),
        0,
      ),

    /** Formats shared context string. */
    formatSharedContext: (sharedContext) =>
      sharedContext?.trim()
        ? Config.SHARED_CONTEXT_TEMPLATE.replace(
            "{sharedContext}",
            sharedContext.trim(),
          )
        : "",

    /** Parses Server-Sent Events (SSE) data string into content chunks. */
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
              // Ensure delta is a string, even if empty
              chunks.push(delta);
            }
          } catch (e) {
            // Log only if content wasn't empty/whitespace
            if (dataContent) {
              Logger.error(`Error parsing SSE chunk JSON:`, dataContent, e);
            }
            // Decide if we should push an empty string or skip? Skipping seems safer.
          }
        }
      }
      return chunks;
    },

    /** Helper to create a ReadableStream for streaming API operations. */
    createApiReadableStream: ({
      apiName,
      apiKey,
      model,
      messages,
      parameters,
      signal,
      accumulated = false,
      responseFormat = "markdown", // Default format
      onSuccess,
    }) => {
      if (signal?.aborted) {
        const abortError = new DOMException(
          "Operation aborted before stream start.",
          "AbortError",
          { cause: signal.reason },
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
      let accumulatedResponseForHistory = ""; // For history update

      const stream = new ReadableStream({
        start: async (controller) => {
          streamController = controller;

          // Abort handler specific to this stream operation
          const abortHandler = (event) => {
            if (requestAbortedOrFinished) return;
            requestAbortedOrFinished = true;
            const error = new DOMException(
              "Operation aborted during stream.",
              "AbortError",
              { cause: signal.reason || event?.reason },
            );
            Logger.warn(`${apiName}: Stream aborted.`, error.cause);
            try {
              streamController?.error(error);
            } catch (e) {
              /* Ignore if controller already closed/errored */
            }
          };
          signal?.addEventListener("abort", abortHandler, { once: true });

          // 1. Check Quota
          const totalTokens = Utils.calculateTotalTokens(messages);
          if (totalTokens > Config.MAX_CONTEXT_TOKENS) {
            const error = new QuotaExceededError(
              `${Config.EMULATED_NAMESPACE}.${apiName}: Input exceeds maximum token limit.`,
              { requested: totalTokens, quota: Config.MAX_CONTEXT_TOKENS },
            );
            Logger.error(
              error.message,
              `Requested: ${totalTokens}, Quota: ${Config.MAX_CONTEXT_TOKENS}`,
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
              signal, // Pass the signal down
              responseFormat: responseFormat, // Pass format down
              on: {
                chunk: (formattedDelta, formattedAccumulated, rawDelta) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  accumulatedResponseForHistory += rawDelta || ""; // Accumulate raw for history
                  try {
                    // Enqueue formatted text (delta or accumulated based on flag)
                    streamController.enqueue(
                      accumulated ? formattedAccumulated : formattedDelta,
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
                    // Pass accumulated raw response to success callback
                    onSuccess?.(accumulatedResponseForHistory);
                  } catch (e) {
                    Logger.warn(
                      `${apiName}: Error during stream close/onSuccess:`,
                      e,
                    );
                    /* Might already be closed/errored */
                  }
                },
                error: (error) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  requestAbortedOrFinished = true;
                  signal?.removeEventListener("abort", abortHandler);
                  Logger.error(
                    `${apiName}: Streaming error received from API call:`,
                    error,
                  );
                  try {
                    // Ensure we propagate the error correctly, especially AbortError
                    streamController.error(error);
                  } catch (e) {
                    Logger.warn(
                      `${apiName}: Error propagating stream error:`,
                      e,
                    );
                  }
                },
              },
            });
          } catch (error) {
            // Catch errors during the askOpenRouter call itself (e.g., setup, initial connection)
            if (!requestAbortedOrFinished && streamController) {
              requestAbortedOrFinished = true;
              signal?.removeEventListener("abort", abortHandler);
              // Don't log AbortError specifically here if it was handled by 'on.error' or the listener
              if (error.name !== "AbortError") {
                Logger.error(
                  `${apiName}: Error during streaming setup/request:`,
                  error,
                );
              }
              try {
                streamController.error(error);
              } catch (e) {
                Logger.warn(
                  `${apiName}: Error setting controller error state:`,
                  e,
                );
              }
            } else if (!streamController) {
              Logger.error(
                `${apiName}: Stream controller unavailable during setup error:`,
                error,
              );
            }
            // If already aborted/finished, the error was likely handled by 'on.error' or the listener
          }
        },
        cancel: (reason) => {
          Logger.log(
            `${apiName}: Stream cancelled by consumer. Reason:`,
            reason,
          );
          requestAbortedOrFinished = true;
          // No need to explicitly abort signal here, cancellation originates from consumer
        },
      });
      return stream;
    },

    /** Simulates the download progress events for the monitor callback. */
    simulateMonitorEvents: (monitorCallback) => {
      if (typeof monitorCallback !== "function") return;
      try {
        const monitorTarget = {
          _listeners: {}, // Store listeners
          addEventListener: function (type, listener) {
            if (typeof listener !== "function") return;
            if (!this._listeners[type]) {
              this._listeners[type] = [];
            }
            this._listeners[type].push(listener);
          },
          removeEventListener: function (type, listener) {
            // Add removeEventListener
            if (!this._listeners[type]) return;
            this._listeners[type] = this._listeners[type].filter(
              (l) => l !== listener,
            );
          },
          dispatchEvent: function (event) {
            // Helper to dispatch
            if (!this._listeners[event.type]) return;
            this._listeners[event.type].forEach((listener) => {
              try {
                listener.call(this, event); // Call listener
              } catch (e) {
                Logger.error(
                  `Error in monitor event listener (${event.type}):`,
                  e,
                );
              }
            });
          },
        };
        monitorCallback(monitorTarget); // Pass the target to the user's function

        // Simulate progress after a short delay
        setTimeout(() => {
          monitorTarget.dispatchEvent(
            new ProgressEvent("downloadprogress", {
              loaded: 0,
              total: 1,
              lengthComputable: true, // Spec says it should be computable
            }),
          );
        }, 5);

        setTimeout(() => {
          monitorTarget.dispatchEvent(
            new ProgressEvent("downloadprogress", {
              loaded: 1,
              total: 1,
              lengthComputable: true,
            }),
          );
          // Optional: Simulate 'loadend' or similar if the spec requires it
          // monitorTarget.dispatchEvent(new ProgressEvent("loadend"));
        }, 50); // Increase delay slightly
      } catch (e) {
        Logger.error(
          `Error calling monitor function or dispatching events:`,
          e,
        );
      }
    },
  };

  // --- Fetch Wrapper ---
  // Decide whether to use GM_fetch or window.fetch based on CSP check
  let _fetch = window.fetch; // Default to window.fetch
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
            `Potential CSP detected for OpenRouter, but GM_fetch is not available. Using window.fetch, requests might fail.`,
          );
        }
      } else {
        // Logger.log(`CSP check passed for OpenRouter. Using standard window.fetch.`);
      }
    })
    .catch((error) => {
      Logger.error("Error during CSP check:", error);
      // Proceed with default fetch, but log the error
    });

  // --- Core API Interaction Logic ---
  const CoreAPI = {
    /**
     * Makes a raw API request to OpenRouter without rate limiting
     * This is the internal implementation that handles the actual API call
     */
    _rawApiRequest: async ({
      apiName, // Added for logging
      apiKey,
      messages,
      model,
      parameters,
      stream = false,
      signal,
      responseFormat = "markdown", // Receive format here
      on, // Callbacks: chunk(formattedDelta, formattedAccumulated, rawDelta), finish(formattedFullMessage), error(error)
    }) => {
      if (!apiKey) {
        const error = new APIError(`OpenRouter API Key is not configured.`);
        on?.error?.(error);
        // Reject the promise returned by this function as well
        return Promise.reject(error);
      }
      if (signal?.aborted) {
        const error = new DOMException(
          "Operation aborted before request.",
          "AbortError",
          { cause: signal.reason },
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

      // Use a controller specific to this request for finer-grained cancellation
      const internalController = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any([signal, internalController.signal])
        : internalController.signal;
      let abortReason = null;

      // Centralized abort handler
      const abortHandler = (event) => {
        if (internalController.signal.aborted) return; // Already aborted internally
        abortReason =
          event?.reason ?? new DOMException("Operation aborted.", "AbortError");
        Logger.warn(
          `${apiName}: Abort detected. Reason:`,
          abortReason?.message || "No reason provided",
        );
        internalController.abort(abortReason); // Trigger internal abort
        // No need to call on.error here, it will be handled in catch blocks or stream processing
      };

      // Listen to the external signal if provided
      signal?.addEventListener("abort", abortHandler, { once: true });

      // Log the prompt before fetching
      Logger.logPrompt(apiName, messages);

      // Return a promise that handles the entire request lifecycle
      return new Promise(async (resolve, reject) => {
        let accumulatedRawResponse = ""; // Accumulate raw response for formatting
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
          signal: combinedSignal, // Use the combined signal for fetch
        };

        try {
          const response = await _fetch(
            Config.OPENROUTER_CHAT_COMPLETIONS_URL,
            requestOptions,
          );

          // --- Handle Response Status ---
          if (!response.ok) {
            let errorText = `API Error ${response.status}`;
            let errorDetail = "";
            try {
              const bodyText = await response.text();
              // Be careful not to log sensitive info if body might contain it
              errorDetail = bodyText.substring(0, 200); // Limit detail length
              errorText = `${errorText}: ${errorDetail}`;
              // Try parsing JSON for more specific error message
              try {
                const jsonError = JSON.parse(bodyText);
                errorDetail = jsonError?.error?.message || errorDetail;
              } catch {
                /* Ignore JSON parse error */
              }
            } catch (bodyError) {
              errorText += ` (Could not read error body: ${bodyError.message})`;
            }
            const error = new APIError(
              `${apiName}: OpenRouter request failed - ${errorDetail || `Status ${response.status}`}`,
              { status: response.status },
            );
            on?.error?.(error);
            reject(error); // Reject the main promise
            return; // Stop processing
          }

          // --- Handle Streaming Response ---
          if (stream) {
            if (!response.body) {
              throw new APIError(
                `${apiName}: Response body is null for stream.`,
              );
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
              // Check for abort *before* reading
              if (combinedSignal.aborted) {
                const error =
                  abortReason ??
                  new DOMException(
                    "Operation aborted during stream read.",
                    "AbortError",
                    { cause: combinedSignal.reason },
                  );
                on?.error?.(error);
                reject(error);
                try {
                  await reader.cancel(error);
                } catch (_) {}
                break;
              }

              const { done, value } = await reader.read();

              // Check for abort *after* reading, *before* processing
              if (combinedSignal.aborted) {
                const error =
                  abortReason ??
                  new DOMException(
                    "Operation aborted post-read.",
                    "AbortError",
                    { cause: combinedSignal.reason },
                  );
                on?.error?.(error);
                reject(error);
                try {
                  await reader.cancel(error);
                } catch (_) {}
                break;
              }

              if (done) {
                if (buffer.trim()) {
                  Logger.warn(
                    `${apiName}: Remaining buffer at stream end:`,
                    buffer,
                  );
                  // Process remaining buffer as final chunk(s)
                  const finalDeltas = Utils.parseSSE(buffer + "\n\n"); // Add delimiter for parser
                  finalDeltas.forEach((delta) => {
                    accumulatedRawResponse += delta;
                    const formattedDelta = Utils.formatResponse(
                      delta,
                      responseFormat,
                    );
                    const formattedAccumulated = Utils.formatResponse(
                      accumulatedRawResponse,
                      responseFormat,
                    );
                    on?.chunk?.(formattedDelta, formattedAccumulated, delta);
                  });
                }
                // Format the final complete response
                const formattedFinalResponse = Utils.formatResponse(
                  accumulatedRawResponse,
                  responseFormat,
                );
                on?.finish?.(formattedFinalResponse);
                resolve(formattedFinalResponse); // Resolve the main promise
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const eventMessages = buffer.split("\n\n");
              buffer = eventMessages.pop() || ""; // Keep incomplete message in buffer

              for (const sseMessage of eventMessages) {
                if (sseMessage.trim()) {
                  const deltas = Utils.parseSSE(sseMessage + "\n\n"); // Add delimiter for parser robustness
                  deltas.forEach((delta) => {
                    accumulatedRawResponse += delta;
                    // Format based on expectations
                    const formattedDelta = Utils.formatResponse(
                      delta,
                      responseFormat,
                    );
                    const formattedAccumulated = Utils.formatResponse(
                      accumulatedRawResponse,
                      responseFormat,
                    );
                    // Provide formatted delta, formatted accumulated, and raw delta to callback
                    on?.chunk?.(formattedDelta, formattedAccumulated, delta);
                  });
                }
              }
            }
            // --- Handle Non-Streaming Response ---
          } else {
            let responseBodyText = "";
            try {
              responseBodyText = await response.text(); // Get text first for better error reporting
              const jsonResponse = JSON.parse(responseBodyText);
              const content = jsonResponse?.choices?.[0]?.message?.content;

              if (typeof content === "string") {
                accumulatedRawResponse = content;
                // Format the content according to expected format *before* resolving/finishing
                const formattedContent = Utils.formatResponse(
                  content,
                  responseFormat,
                );
                on?.finish?.(formattedContent);
                resolve(formattedContent); // Resolve the main promise
              } else {
                Logger.error(
                  `${apiName}: Invalid non-streaming response structure. Content missing or not string.`,
                  jsonResponse,
                );
                throw new APIError(
                  `${apiName}: Invalid response structure from OpenRouter (content missing).`,
                );
              }
            } catch (parseError) {
              Logger.error(
                `${apiName}: Failed to parse non-streaming JSON response: ${parseError.message}`,
                responseBodyText,
              );
              throw new APIError(
                `${apiName}: Failed to parse response from OpenRouter.`,
                { cause: parseError },
              );
            }
          }
        } catch (error) {
          // --- Handle Errors During Fetch/Processing ---
          let finalError = error;
          // If the combined signal aborted, ensure we have an AbortError
          if (combinedSignal.aborted && error.name !== "AbortError") {
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
            // Wrap unexpected errors
            Logger.error(
              `${apiName}: Unexpected error during API call:`,
              error,
            );
            finalError = new APIError(
              `${apiName}: Network or processing error: ${error.message}`,
              { cause: error },
            );
          }

          // Ensure the error callback is called and the promise is rejected
          on?.error?.(finalError);
          reject(finalError);
        } finally {
          // --- Cleanup ---
          // Remove the specific abort listener for the external signal
          signal?.removeEventListener("abort", abortHandler);
          // Ensure internal controller is aborted if not already (e.g., normal completion)
          if (!internalController.signal.aborted) {
            internalController.abort(
              new DOMException("Operation finished or errored.", "AbortError"),
            );
          }
        }
      });
    },

    /**
     * Central function to make rate-limited requests to OpenRouter
     * Uses the rate limiter to debounce and limit requests
     */
    askOpenRouter: async ({
      apiName, // For logging and keying
      apiKey,
      messages,
      model,
      parameters,
      stream = false,
      signal,
      responseFormat = "markdown", // Pass format down
      on, // Callbacks passed down
    }) => {
      // Generate a unique key for debouncing. Simple hash of key parts.
      // Avoid stringifying large messages for performance. Use message count/length hash?
      // Let's use API name + model + simple message indicator.
      const messageIndicator =
        messages.length > 0
          ? messages[0]?.content?.substring(0, 20)
          : "no_msgs";
      const requestKey = `${apiName}-${model}-${messageIndicator}`;

      try {
        // Use the rate limiter to execute the raw request
        return await apiRateLimiter.execute(
          // Function to execute: the raw API request
          () =>
            CoreAPI._rawApiRequest({
              apiName,
              apiKey,
              messages,
              model,
              parameters,
              stream,
              signal,
              responseFormat, // Pass format
              on, // Pass callbacks
            }),
          // Debounce key
          requestKey,
          // Arguments for the function (none needed here as they are bound in the closure)
        );
      } catch (error) {
        // Handle errors specifically from the rate limiter or the request itself
        if (
          error instanceof APIError &&
          error.message.includes("Rate limit exceeded")
        ) {
          Logger.warn(
            `${apiName}: Rate limit exceeded. Request key: ${requestKey}`,
          );
          // Ensure the 'on.error' callback is triggered for rate limit errors too
          on?.error?.(error);
        } else if (error.name === "AbortError") {
          // Abort errors should also be propagated via on.error if needed
          on?.error?.(error);
        } else if (
          !(error instanceof APIError || error instanceof QuotaExceededError)
        ) {
          // Log unexpected errors from the execute wrapper/promise
          Logger.error(
            `${apiName}: Unexpected error in askOpenRouter wrapper:`,
            error,
          );
          on?.error?.(
            new APIError(`askOpenRouter Error: ${error.message}`, {
              cause: error,
            }),
          );
        }
        // Re-throw the error so the caller knows the operation failed
        throw error;
      }
    },
  };

  // --- API Key Management ---
  const KeyManager = {
    promptForApiKey: async () => {
      const currentKey =
        openRouterApiKey ?? (await GM_getValue(Config.API_KEY_STORAGE_KEY, ""));
      const newKey = prompt(
        "Enter OpenRouter API Key (https://openrouter.ai/keys):",
        currentKey,
      );
      if (newKey === null) {
        alert("API Key entry cancelled.");
      } else if (newKey === "" && currentKey !== "") {
        await KeyManager.clearApiKey(false); // Don't confirm if clearing via prompt
      } else if (newKey !== "" && newKey !== currentKey) {
        // Basic validation: Check if it looks like an OpenRouter key (sk-or-...)
        if (!newKey.startsWith("sk-or-")) {
          alert(
            "Warning: Key does not start with 'sk-or-'. It might be invalid. Saving anyway.",
          );
        }
        await GM_setValue(Config.API_KEY_STORAGE_KEY, newKey);
        openRouterApiKey = newKey;
        alert("API Key saved. Reloading page to apply changes...");
        window.location.reload(); // Force reload
      } else if (newKey === "" && currentKey === "") {
        // No change if prompt was empty and no key existed
      } else {
        alert("API Key unchanged."); // Key submitted was the same as current
      }
    },
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
          "Are you sure you want to clear the stored OpenRouter API Key?",
        );
      if (confirmed) {
        await GM_deleteValue(Config.API_KEY_STORAGE_KEY);
        openRouterApiKey = null; // Clear runtime variable
        alert("OpenRouter API Key cleared. Reloading page...");
        window.location.reload(); // Force reload
      } else {
        alert("API Key clearing cancelled.");
      }
    },
    ensureApiKeyLoaded: async () => {
      if (!openRouterApiKey) {
        openRouterApiKey = await GM_getValue(Config.API_KEY_STORAGE_KEY, null);
      }
      return openRouterApiKey;
    },
    getOpenRouterKeyDetails: async () => {
      const apiKey = await KeyManager.ensureApiKeyLoaded();
      if (!apiKey) {
        alert(
          "OpenRouter API Key is not set. Please set it using the Tampermonkey menu command.",
        );
        // Optionally trigger the prompt?
        // KeyManager.promptForApiKey();
        return null;
      }

      try {
        // Use a short timeout for this check
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout

        const response = await _fetch(Config.OPENROUTER_KEY_CHECK_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": Config.YOUR_SITE_URL, // Could be optional
            "X-Title": Config.YOUR_APP_NAME, // Could be optional
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId); // Clear timeout if fetch returned

        if (!response.ok) {
          let errorText = `Status ${response.status}`;
          try {
            const body = await response.text();
            errorText += `: ${body.substring(0, 150)}`; // Limit length
            if (response.status === 401) {
              errorText =
                "Invalid API Key (Unauthorized). Please check or reset your key.";
            }
          } catch {
            /* Ignore body read error */
          }
          alert(`Error fetching key details: ${errorText}`);
          Logger.error(`API key check failed ${response.status}:`, errorText);
          return null;
        }

        const data = await response.json();
        return data?.data; // Structure might change, be defensive
      } catch (error) {
        let errorMessage = `Error fetching key details: ${error.message}`;
        if (error.name === "AbortError") {
          errorMessage = "Error fetching key details: Request timed out.";
        } else if (error instanceof TypeError && !_isGmFetchUsed) {
          // Suggest GM_fetch if TypeError occurs and we are using window.fetch
          errorMessage +=
            "\nA TypeError occurred. This might be due to CORS/CSP. If problems persist, ensure GM_fetch is enabled and potentially adjust @connect in the script header.";
        }
        alert(errorMessage);
        Logger.error(`Error during key check:`, error);
        return null;
      }
    },

    showKeyStatus: async () => {
      const details = await KeyManager.getOpenRouterKeyDetails();
      if (details) {
        const formatCurrency = (val) =>
          val !== undefined && val !== null && !isNaN(Number(val))
            ? `$${Number(val).toFixed(4)}`
            : "N/A";
        const usage = formatCurrency(details.usage);
        const limit = formatCurrency(details.limit) || "Unlimited"; // Show unlimited if null/undefined
        const remaining = formatCurrency(details.limit_remaining);
        const reqLimit = details.rate_limit?.requests ?? "N/A";
        const interval = details.rate_limit?.interval ?? "N/A";
        const isFree =
          details.is_free_tier === true
            ? "Yes"
            : details.is_free_tier === false
              ? "No"
              : "N/A";

        // Construct message carefully checking for undefined/null
        let message = `--- OpenRouter Key Status ---`;
        message += `\nLabel: ${details.label || "N/A"}`;
        message += `\nFree Tier: ${isFree}`;
        if (details.limit !== null && details.limit !== undefined) {
          // Only show usage/limit/remaining if a limit exists
          message += `\nUsage: ${usage}`;
          message += `\nLimit: ${limit}`;
          message += `\nRemaining: ${remaining}`;
        } else {
          message += `\nUsage: ${usage}`;
          message += `\nLimit: ${limit}`;
        }
        if (details.rate_limit) {
          message += `\nRate Limit: ${reqLimit} req / ${interval}`;
        } else {
          message += `\nRate Limit: N/A`;
        }

        alert(message);
      } else {
        // Error message already shown by getOpenRouterKeyDetails
      }
    },
  };

  // --- API Implementation Helpers ---

  class BaseApiInstance {
    _apiKey;
    _model;
    _options;
    _instanceAbortController;
    _creationSignal; // Signal passed during creation
    _combinedSignal; // Signal combining creation and instance signals
    _apiName;

    constructor(apiName, apiKey, defaultModel, options = {}) {
      this._apiName = apiName;
      this._apiKey = apiKey;
      this._model = defaultModel; // Specific instance might override based on options
      this._options = { ...options }; // Copy options
      this._creationSignal = options?.signal;
      this._instanceAbortController = new AbortController();

      // Combine signals: if the creation signal aborts OR the instance is destroyed, abort.
      const signalsToCombine = [this._instanceAbortController.signal];
      if (this._creationSignal) {
        signalsToCombine.push(this._creationSignal);
      }
      // Use AbortSignal.any if available (modern browsers)
      if (typeof AbortSignal.any === "function") {
        this._combinedSignal = AbortSignal.any(signalsToCombine);
      } else {
        // Fallback: listen to both signals manually (less efficient)
        this._combinedSignal = this._instanceAbortController.signal; // Start with instance signal
        const manualAbortHandler = (reason) => {
          if (!this._instanceAbortController.signal.aborted) {
            this._instanceAbortController.abort(reason);
          }
        };
        this._creationSignal?.addEventListener(
          "abort",
          () => manualAbortHandler(this._creationSignal.reason),
          { once: true },
        );
        // Note: This fallback doesn't perfectly replicate AbortSignal.any's immediate propagation
        // but is better than only listening to one signal.
      }

      // Check for immediate abort during creation
      if (this._combinedSignal.aborted) {
        const creationReason = this._creationSignal?.reason;
        const message = `${this._apiName} creation aborted.`;
        Logger.warn(message, creationReason);
        // Ensure destroy logic runs even if constructor throws
        this.destroy();
        throw creationReason || new DOMException(message, "AbortError");
      }

      Utils.simulateMonitorEvents(options?.monitor); // Simulate monitor events if requested

      // Log ignored options common across APIs
      if (options?.expectedContextLanguages) {
        Logger.warn(
          `${apiName}: Option 'expectedContextLanguages' is noted but not actively used by the emulator.`,
        );
      }
      if (options?.outputLanguage) {
        Logger.warn(
          `${apiName}: Option 'outputLanguage' is noted but not actively used by the emulator (except implicitly in Translator).`,
        );
      }
    }

    /**
     * Creates a new instance with the same configuration as this one.
     * Derived classes should override this method to include class-specific properties.
     * @returns {BaseApiInstance} A new instance with the same configuration
     */
    clone() {
      Logger.log(`${this._apiName}: Creating clone of instance`);
      // Create a new instance with the same *original* options used for this one.
      // Pass a new signal if the original clone call provided one, otherwise undefined.
      // Note: Cloning does not typically propagate the *instance's* abort signal,
      // it creates a new independent instance. The *creation* signal might be relevant
      // if the clone operation itself needs to be abortable, but the spec is unclear.
      // We'll pass the original options (which might include a signal for the clone's creation).
      const clonedInstance = new this.constructor(this._apiKey, {
        ...this._options,
      });
      // Copy the effective model determined by the constructor
      clonedInstance._model = this._model;
      return clonedInstance;
    }

    get inputQuota() {
      // Could potentially get model-specific quota later if needed
      return Config.MAX_CONTEXT_TOKENS;
    }

    async measureInputUsage(text) {
      // Basic token estimation
      return Promise.resolve(Utils.tokenize(text));
    }

    destroy() {
      if (!this._instanceAbortController.signal.aborted) {
        Logger.log(`${this._apiName}: Instance destroy() called.`);
        this._instanceAbortController.abort(
          new DOMException(
            `${this._apiName} instance explicitly destroyed.`,
            "AbortError",
          ),
        );
      }
      // Clean up any other resources if needed in future
    }

    // --- Internal API Request Helpers ---

    /** Performs a non-streaming API request */
    async _performApiRequest({ messages, callOptions = {}, parameters = {} }) {
      const operationSignal = callOptions.signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([this._combinedSignal, callOptions.signal])
          : this._combinedSignal // Prefer combined signal if call signal present, fallback needs checking AbortSignal.any
        : this._combinedSignal;

      // Check abort before proceeding
      if (operationSignal.aborted) {
        const reason =
          operationSignal.reason ||
          new DOMException(
            `${this._apiName} operation aborted before start.`,
            "AbortError",
          );
        Logger.warn(reason.message);
        throw reason;
      }

      // Determine response format: Call option > Instance option > Default
      const responseFormat =
        callOptions.responseFormat || this._options.format || "markdown";

      // Check token quota
      const totalTokens = Utils.calculateTotalTokens(messages);
      if (totalTokens > this.inputQuota) {
        const error = new QuotaExceededError(
          `${this._apiName}: Input exceeds token limit.`,
          { requested: totalTokens, quota: this.inputQuota },
        );
        Logger.error(error.message);
        throw error;
      }

      try {
        let apiError = null; // Variable to capture error from 'on.error'
        const result = await CoreAPI.askOpenRouter({
          apiName: this._apiName,
          apiKey: this._apiKey,
          messages,
          model: this._model, // Use the instance's resolved model
          parameters,
          stream: false,
          signal: operationSignal, // Pass the combined signal
          responseFormat: responseFormat, // Pass the determined format
          on: {
            finish: (/* formattedMsg */) =>
              Logger.log(`${this._apiName}: Non-streaming request finished.`),
            error: (err) => {
              // Don't log AbortError noise here, it's handled below
              if (err.name !== "AbortError") {
                Logger.error(
                  `${this._apiName}: Error reported during non-streaming request:`,
                  err,
                );
              }
              apiError = err; // Capture the error
            },
          },
        });

        // If 'on.error' captured an error, or if askOpenRouter threw, handle it
        if (apiError) {
          throw apiError; // Throw the error reported by the callback
        }

        // askOpenRouter should have already formatted the result based on responseFormat
        return result;
      } catch (error) {
        // Handle errors: AbortError, QuotaExceededError, APIError, or others
        if (error.name === "AbortError" || operationSignal.aborted) {
          // Throw the specific AbortError reason if available
          throw operationSignal.reason || error;
        } else if (
          error instanceof QuotaExceededError ||
          error instanceof APIError
        ) {
          // Re-throw known API-related errors directly
          throw error;
        } else {
          // Wrap unexpected errors
          Logger.error(
            `${this._apiName}: Unexpected error during non-streaming API request:`,
            error,
          );
          throw new APIError(
            `${this._apiName}: Failed to complete operation. ${error.message}`,
            { cause: error },
          );
        }
      }
    }

    /** Performs a streaming API request */
    _performApiStreamingRequest({
      messages,
      callOptions = {},
      parameters = {},
      accumulated = false, // Whether the stream yields accumulated text or deltas
      onSuccess, // Callback with full raw text on successful completion
    }) {
      const operationSignal = callOptions.signal
        ? typeof AbortSignal.any === "function"
          ? AbortSignal.any([this._combinedSignal, callOptions.signal])
          : this._combinedSignal
        : this._combinedSignal;

      // Determine response format: Call option > Instance option > Default
      const responseFormat =
        callOptions.responseFormat || this._options.format || "markdown";

      // CreateApiReadableStream handles quota checking and the CoreAPI call
      return Utils.createApiReadableStream({
        apiName: this._apiName,
        apiKey: this._apiKey,
        model: this._model, // Use the instance's resolved model
        messages,
        parameters,
        signal: operationSignal, // Pass the combined signal
        accumulated,
        responseFormat, // Pass the determined format
        onSuccess, // Pass the success callback through
      });
    }
  }

  // --- API Implementations ---

  class LanguageModelSession extends BaseApiInstance {
    _history;
    _parameters; // Holds temperature, topK for the session

    constructor(apiKey, options = {}) {
      super("languageModel", apiKey, Config.DEFAULT_PROMPT_MODEL, options);

      // Validate and set session parameters (temperature, topK)
      this._parameters = {
        temperature: Config.DEFAULT_TEMPERATURE,
        topK: Config.DEFAULT_TOP_K,
      };
      if (options.temperature !== undefined) {
        if (
          options.temperature > Config.MAX_TEMPERATURE ||
          options.temperature < 0
        ) {
          Logger.warn(
            `${this._apiName}: Initial temperature ${options.temperature} out of range [0, ${Config.MAX_TEMPERATURE}]. Clamping.`,
          );
          this._parameters.temperature = Math.max(
            0,
            Math.min(Config.MAX_TEMPERATURE, options.temperature),
          );
        } else {
          this._parameters.temperature = options.temperature;
        }
      }
      if (options.topK !== undefined) {
        if (options.topK > Config.MAX_TOP_K || options.topK <= 0) {
          Logger.warn(
            `${this._apiName}: Initial topK ${options.topK} out of range (0, ${Config.MAX_TOP_K}]. Clamping.`,
          );
          this._parameters.topK = Math.max(
            1,
            Math.min(Config.MAX_TOP_K, options.topK),
          ); // topK > 0
        } else {
          this._parameters.topK = options.topK;
        }
      }

      // Initialize history, considering systemPrompt and initialPrompts
      this._history = this._initializeHistory(options);

      // Check for abort *after* initialization
      if (this._combinedSignal.aborted) {
        this.destroy(); // Ensure cleanup
        throw (
          this._combinedSignal.reason ||
          new DOMException("languageModel creation aborted.", "AbortError")
        );
      }
      Logger.log(
        `${this._apiName}: Session created. Temp: ${this._parameters.temperature}, TopK: ${this._parameters.topK}, History items: ${this._history.length}`,
      );
    }

    // --- Initialization Helpers ---
    _initializeHistory(options) {
      const history = [];
      const initial = options.initialPrompts;

      // Validate initialPrompts format
      if (
        initial &&
        (!Array.isArray(initial) ||
          initial.some(
            (p) =>
              typeof p !== "object" || !p.role || typeof p.content !== "string",
          ))
      ) {
        throw new TypeError(
          "Invalid initialPrompts format. Expected array of {role: string, content: string}.",
        );
      }

      const systemInInitial = initial?.find((p) => p.role === "system");
      const hasExplicitSystemPrompt =
        typeof options.systemPrompt === "string" &&
        options.systemPrompt.length > 0;

      // Ensure system prompt rules are followed
      if (hasExplicitSystemPrompt && systemInInitial) {
        throw new TypeError(
          "Cannot provide both systemPrompt option and a system role message in initialPrompts.",
        );
      }
      if (systemInInitial && initial[0].role !== "system") {
        throw new TypeError(
          "If initialPrompts contains a system role message, it must be the first message.",
        );
      }

      // Add system prompt if provided
      if (hasExplicitSystemPrompt) {
        history.push({ role: "system", content: options.systemPrompt });
      }

      // Add initial prompts (which might include a system prompt if hasExplicitSystemPrompt was false)
      if (initial) {
        history.push(...initial);
      }

      // Validate history structure (e.g., alternating roles if applicable, though the API is flexible)
      // Basic check: ensure roles are valid ('system', 'user', 'assistant')
      const validRoles = ["system", "user", "assistant"];
      if (history.some((msg) => !validRoles.includes(msg.role))) {
        throw new TypeError(
          "Invalid role found in initial prompts or system prompt.",
        );
      }

      return history;
    }

    // --- Input Parsing ---
    _parseInput(input) {
      if (typeof input === "string") {
        return [{ role: "user", content: input }];
      }
      if (Array.isArray(input)) {
        // Validate format: array of {role: string, content: string}
        if (
          input.some(
            (msg) =>
              typeof msg !== "object" ||
              !msg.role ||
              typeof msg.content !== "string",
          )
        ) {
          throw new TypeError(
            "Invalid input format. Expected string or array of {role: string, content: string}.",
          );
        }
        // Basic role validation for input messages (usually should be 'user')
        // Allowing 'assistant' might be valid for some use cases, but generally input is from user.
        // if (input.some(msg => msg.role !== 'user')) {
        //    Logger.warn("Input array contains non-'user' roles.");
        // }
        return input;
      }
      throw new TypeError(
        "Invalid input type. Expected string or array of {role: string, content: string}.",
      );
    }

    // --- Parameter Preparation ---
    _prepareParameters(callOptions = {}) {
      // Start with session-level parameters
      const parameters = { ...this._parameters };

      // Apply per-call parameters if provided and valid
      if (callOptions.temperature !== undefined) {
        if (
          callOptions.temperature > Config.MAX_TEMPERATURE ||
          callOptions.temperature < 0
        ) {
          Logger.warn(
            `${this._apiName}: Call temperature ${callOptions.temperature} out of range [0, ${Config.MAX_TEMPERATURE}]. Clamping.`,
          );
          parameters.temperature = Math.max(
            0,
            Math.min(Config.MAX_TEMPERATURE, callOptions.temperature),
          );
        } else {
          parameters.temperature = callOptions.temperature;
        }
      }
      if (callOptions.topK !== undefined) {
        if (callOptions.topK > Config.MAX_TOP_K || callOptions.topK <= 0) {
          Logger.warn(
            `${this._apiName}: Call topK ${callOptions.topK} out of range (0, ${Config.MAX_TOP_K}]. Clamping.`,
          );
          parameters.topK = Math.max(
            1,
            Math.min(Config.MAX_TOP_K, callOptions.topK),
          );
        } else {
          parameters.topK = callOptions.topK;
        }
      }

      return parameters;
    }

    // --- Message Preparation ---
    _prepareMessages(input, callOptions = {}) {
      const currentUserMessages = this._parseInput(input); // Validate and format input
      let messagesForApi = [...this._history]; // Start with current session history

      // Handle per-call system prompt
      if (typeof callOptions.systemPrompt === "string") {
        // Check if history *already* starts with a system prompt
        if (messagesForApi.length > 0 && messagesForApi[0].role === "system") {
          // Replace the existing system prompt
          messagesForApi[0] = {
            role: "system",
            content: callOptions.systemPrompt,
          };
          Logger.log(
            `${this._apiName}: Replacing session system prompt with per-call system prompt.`,
          );
        } else {
          // Prepend the new system prompt
          messagesForApi.unshift({
            role: "system",
            content: callOptions.systemPrompt,
          });
          Logger.log(`${this._apiName}: Prepending per-call system prompt.`);
        }
      }

      // Add the new user message(s)
      messagesForApi.push(...currentUserMessages);

      // Optional: Add logic here to truncate history if it exceeds context limits,
      // but the quota check in _performApiRequest currently handles the hard limit.

      return { messagesForApi, currentUserMessages };
    }

    // --- Public API Methods ---

    async prompt(input, callOptions = {}) {
      const { messagesForApi, currentUserMessages } = this._prepareMessages(
        input,
        callOptions,
      );
      const parameters = this._prepareParameters(callOptions);

      // Perform the non-streaming request
      const assistantResponse = await this._performApiRequest({
        messages: messagesForApi,
        callOptions, // Pass callOptions for signal, responseFormat etc.
        parameters,
      });

      // Update history *only* on successful completion
      this._history.push(...currentUserMessages, {
        role: "assistant",
        content: assistantResponse, // Use the raw response for history
      });
      Logger.log(
        `${this._apiName}: prompt completed. History updated to ${this._history.length} items.`,
      );

      // The API returns the formatted response directly from _performApiRequest
      return assistantResponse;
    }

    promptStreaming(input, callOptions = {}) {
      const { messagesForApi, currentUserMessages } = this._prepareMessages(
        input,
        callOptions,
      );
      const parameters = this._prepareParameters(callOptions);

      // Perform the streaming request
      // Define the onSuccess callback to update history after the stream finishes
      const updateHistoryOnSuccess = (fullRawResponse) => {
        // Check if the operation was successful (fullRawResponse might be empty on error/abort)
        if (typeof fullRawResponse === "string") {
          this._history.push(...currentUserMessages, {
            role: "assistant",
            content: fullRawResponse, // Use the full raw response accumulated by the stream helper
          });
          Logger.log(
            `${this._apiName}: promptStreaming completed. History updated to ${this._history.length} items.`,
          );
        } else {
          // This case shouldn't happen if stream completes successfully, but log if it does
          Logger.warn(
            `${this._apiName}: promptStreaming onSuccess callback received non-string response. History not updated for assistant turn.`,
          );
          // Still add user messages as they were sent
          this._history.push(...currentUserMessages);
        }
      };

      // Create the stream, passing the history update callback
      return this._performApiStreamingRequest({
        messages: messagesForApi,
        callOptions, // Pass callOptions for signal, responseFormat etc.
        parameters,
        accumulated: false, // Prompt stream yields deltas
        onSuccess: updateHistoryOnSuccess, // Pass the callback
      });
    }

    async countPromptTokens(input) {
      // Note: This counts tokens for the *input* only, not the whole history.
      // The spec is slightly ambiguous here. Let's assume it means tokenizing the input provided.
      try {
        const messagesToCount = this._parseInput(input); // Parse the input string or array
        const tokenCount = Utils.calculateTotalTokens(messagesToCount);
        return Promise.resolve(tokenCount);
      } catch (error) {
        Logger.error(`${this._apiName}.countPromptTokens error:`, error);
        // Re-throw TypeError for invalid input format
        if (error instanceof TypeError) {
          throw error;
        }
        // Wrap other errors
        throw new APIError(`Failed to count tokens: ${error.message}`, {
          cause: error,
        });
      }
    }

    /**
     * Creates a clone of this language model session with the same configuration and history.
     * @returns {LanguageModelSession} A new instance with copied configuration and history
     */
    clone() {
      // Use base class clone to handle options, apiKey, model etc.
      const clonedInstance = super.clone();

      // Deep copy specific session state: parameters and history
      clonedInstance._parameters = { ...this._parameters };
      clonedInstance._history = this._history.map((msg) => ({ ...msg })); // Deep copy history array

      Logger.log(
        `${this._apiName}: Cloned session. History items: ${clonedInstance._history.length}`,
      );
      return clonedInstance;
    }
  }

  class SummarizerInstance extends BaseApiInstance {
    _systemPrompt;

    constructor(apiKey, options = {}) {
      // Summarizer spec options: type, format, length, sharedContext
      super("summarizer", apiKey, Config.DEFAULT_SUMMARIZER_MODEL, options);

      const type = options.type ?? "key-points"; // Default type
      const format = options.format ?? "markdown"; // Default format influences system prompt and potentially default response format
      const length = options.length ?? "medium"; // Default length
      const sharedContextSection = Utils.formatSharedContext(
        options.sharedContext,
      );

      this._systemPrompt = Config.SUMMARIZER_SYSTEM_PROMPT.replace(
        "{type}",
        type,
      )
        .replace("{format}", format) // System prompt requests this format
        .replace("{length}", length)
        .replace("{sharedContextSection}", sharedContextSection);

      // Check for abort *after* initialization
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._combinedSignal.reason ||
          new DOMException("summarizer creation aborted.", "AbortError")
        );
      }
      Logger.log(
        `${this._apiName}: Instance created. Type: ${type}, Format: ${format}, Length: ${length}`,
      );
    }

    /**
     * Creates a clone of this summarizer instance.
     * @returns {SummarizerInstance} A new instance with the same configuration.
     */
    clone() {
      const clonedInstance = super.clone(); // Handles base options, api key, model
      // Copy derived state specific to Summarizer
      clonedInstance._systemPrompt = this._systemPrompt;
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    async summarize(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.summarize must be a string.`,
        );
      }

      let userPromptContent = `Summarize the following text:\n\`\`\`\n${text}\n\`\`\``;
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

      // _performApiRequest will handle responseFormat using callOptions.responseFormat falling back to this._options.format
      return this._performApiRequest({
        messages,
        callOptions, // Pass through for signal, responseFormat, etc.
      });
    }

    summarizeStreaming(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.summarizeStreaming must be a string.`,
        );
      }

      let userPromptContent = `Summarize the following text:\n\`\`\`\n${text}\n\`\`\``;
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

      // _performApiStreamingRequest handles responseFormat similarly
      // Summarizer stream yields deltas based on spec interpretation
      return this._performApiStreamingRequest({
        messages,
        callOptions, // Pass through for signal, responseFormat, etc.
        accumulated: false, // Summarizer streams deltas
        // No specific onSuccess logic needed here beyond base class
      });
    }
  }

  class WriterInstance extends BaseApiInstance {
    _systemPrompt;

    constructor(apiKey, options = {}) {
      // Writer spec options: tone, length, sharedContext
      super("writer", apiKey, Config.DEFAULT_WRITER_MODEL, options);

      const tone = options.tone ?? "neutral";
      const length = options.length ?? "medium";
      const sharedContextSection = Utils.formatSharedContext(
        options.sharedContext,
      );
      // Note: Writer spec doesn't mention 'format' at creation, but we might use options.format as default response format.

      this._systemPrompt = Config.WRITER_SYSTEM_PROMPT.replace("{tone}", tone)
        .replace("{length}", length)
        .replace("{sharedContextSection}", sharedContextSection);

      // Check for abort *after* initialization
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._combinedSignal.reason ||
          new DOMException("writer creation aborted.", "AbortError")
        );
      }
      Logger.log(
        `${this._apiName}: Instance created. Tone: ${tone}, Length: ${length}`,
      );
    }

    /**
     * Creates a clone of this writer instance.
     * @returns {WriterInstance} A new instance with the same configuration.
     */
    clone() {
      const clonedInstance = super.clone(); // Handles base options, api key, model
      // Copy derived state specific to Writer
      clonedInstance._systemPrompt = this._systemPrompt;
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    async write(taskPrompt, callOptions = {}) {
      if (typeof taskPrompt !== "string") {
        throw new TypeError(
          `Input 'taskPrompt' for ${this._apiName}.write must be a string.`,
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

      // _performApiRequest handles responseFormat
      return this._performApiRequest({ messages, callOptions });
    }

    writeStreaming(taskPrompt, callOptions = {}) {
      if (typeof taskPrompt !== "string") {
        throw new TypeError(
          `Input 'taskPrompt' for ${this._apiName}.writeStreaming must be a string.`,
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

      // Writer stream yields accumulated text based on spec interpretation
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: true, // Writer streams accumulated text
        // No specific onSuccess logic needed here
      });
    }
  }

  class RewriterInstance extends BaseApiInstance {
    // No specific system prompt stored at creation, built per-call based on instructions.
    // options.sharedContext is stored in this._options by the base class.

    constructor(apiKey, options = {}) {
      // Rewriter spec options: sharedContext (at creation), instructions (at call time)
      super("rewriter", apiKey, Config.DEFAULT_REWRITER_MODEL, options);

      // Check for abort *after* initialization
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._combinedSignal.reason ||
          new DOMException("rewriter creation aborted.", "AbortError")
        );
      }
      Logger.log(`${this._apiName}: Instance created.`);
      // Note: options.tone and options.length are NOT standard creation options for Rewriter.
      if (options.tone || options.length) {
        Logger.warn(
          `${this._apiName}: 'tone' and 'length' are not standard creation options for Rewriter, they are used as guidelines in the prompt during 'rewrite'/'rewriteStreaming' calls.`,
        );
      }
    }

    /**
     * Creates a clone of this rewriter instance.
     * @returns {RewriterInstance} A new instance with the same configuration.
     */
    clone() {
      // Base clone is sufficient as Rewriter doesn't have extra derived state beyond options.
      const clonedInstance = super.clone();
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    // Helper to build system prompt dynamically for each call
    _buildSystemPrompt(callOptions = {}) {
      const instructions = callOptions.instructions; // Required for rewrite call
      const sharedCtx = this._options.sharedContext; // From instance creation
      // Tone/length are guidance, not strict parameters for rewrite itself
      const tone = callOptions.tone ?? "neutral";
      const length = callOptions.length ?? "medium";

      if (typeof instructions !== "string" || !instructions.trim()) {
        // Spec implies instructions are needed, but let's be robust.
        // Throwing an error might be better according to spec adherence.
        Logger.warn(
          `${this._apiName}: Call is missing 'instructions'. Proceeding with generic rewrite prompt.`,
        );
        // throw new TypeError(`${this._apiName}: 'instructions' option is required for rewrite/rewriteStreaming.`);
      }

      const sharedContextSection = Utils.formatSharedContext(sharedCtx);
      const instructionsSection = instructions?.trim()
        ? `${instructions.trim()}`
        : "Rewrite the text according to the guidelines.";

      return Config.REWRITER_SYSTEM_PROMPT.replace(
        "{instructionsSection}",
        instructionsSection,
      )
        .replace("{sharedContextSection}", sharedContextSection)
        .replace("{tone}", tone) // Pass tone guideline
        .replace("{length}", length); // Pass length guideline
    }

    async rewrite(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.rewrite must be a string.`,
        );
      }
      // Instructions are crucial for rewriter
      if (
        typeof callOptions.instructions !== "string" ||
        !callOptions.instructions.trim()
      ) {
        Logger.warn(
          `${this._apiName}.rewrite called without 'instructions'. Result may be unpredictable.`,
        );
        // Consider throwing: throw new TypeError("Missing 'instructions' in callOptions for rewriter.rewrite");
      }

      const systemPrompt = this._buildSystemPrompt(callOptions);

      let userPromptContent = `Original Text:\n\`\`\`\n${text}\n\`\`\``;
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

    rewriteStreaming(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.rewriteStreaming must be a string.`,
        );
      }
      // Instructions check
      if (
        typeof callOptions.instructions !== "string" ||
        !callOptions.instructions.trim()
      ) {
        Logger.warn(
          `${this._apiName}.rewriteStreaming called without 'instructions'. Result may be unpredictable.`,
        );
        // Consider throwing: throw new TypeError("Missing 'instructions' in callOptions for rewriter.rewriteStreaming");
      }

      const systemPrompt = this._buildSystemPrompt(callOptions);

      let userPromptContent = `Original Text:\n\`\`\`\n${text}\n\`\`\``;
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

      // Rewriter stream yields accumulated text based on spec interpretation
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: true, // Rewriter streams accumulated text
        // No specific onSuccess logic needed here
      });
    }
  }

  class TranslatorInstance extends BaseApiInstance {
    _sourceLanguage; // BCP 47 code
    _targetLanguage; // BCP 47 code
    _systemPrompt;

    constructor(apiKey, options = {}) {
      // Validate required language options
      if (
        typeof options.sourceLanguage !== "string" ||
        !options.sourceLanguage
      ) {
        throw new TypeError(
          `${Config.EMULATED_NAMESPACE}.Translator: Missing or invalid 'sourceLanguage' option.`,
        );
      }
      if (
        typeof options.targetLanguage !== "string" ||
        !options.targetLanguage
      ) {
        throw new TypeError(
          `${Config.EMULATED_NAMESPACE}.Translator: Missing or invalid 'targetLanguage' option.`,
        );
      }

      // Use 'Translator' for logging clarity within the base class
      super("Translator", apiKey, Config.DEFAULT_TRANSLATOR_MODEL, options);

      this._sourceLanguage = options.sourceLanguage;
      this._targetLanguage = options.targetLanguage;

      // Attempt to get human-readable names, fallback to codes if needed
      const sourceLanguageLong = Utils.languageTagToHumanReadable(
        this._sourceLanguage,
        "en",
      ); // Use English for names
      const targetLanguageLong = Utils.languageTagToHumanReadable(
        this._targetLanguage,
        "en",
      );

      // Build the system prompt
      this._systemPrompt = Config.TRANSLATOR_SYSTEM_PROMPT.replace(
        "{sourceLanguage}",
        this._sourceLanguage,
      )
        .replace("{targetLanguage}", this._targetLanguage)
        .replace("{sourceLanguageLong}", sourceLanguageLong)
        .replace("{targetLanguageLong}", targetLanguageLong);

      // Check for abort *after* initialization
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._combinedSignal.reason ||
          new DOMException("Translator creation aborted.", "AbortError")
        );
      }
      Logger.log(
        `${this._apiName}: Instance created. Source: ${this._sourceLanguage} (${sourceLanguageLong}), Target: ${this._targetLanguage} (${targetLanguageLong})`,
      );

      // Translator response format is implicitly plain-text, log warning if format option was provided
      if (options.format && options.format !== "plain-text") {
        Logger.warn(
          `${this._apiName}: 'format' option "${options.format}" provided at creation, but Translator typically outputs plain text. The system prompt requests plain text output.`,
        );
      }
      // Set default format to plain-text for this instance
      this._options.format = "plain-text";
    }

    /**
     * Creates a clone of this translator instance.
     * @returns {TranslatorInstance} A new instance with the same configuration.
     */
    clone() {
      const clonedInstance = super.clone(); // Handles base options, api key, model
      // Copy derived state specific to Translator
      clonedInstance._sourceLanguage = this._sourceLanguage;
      clonedInstance._targetLanguage = this._targetLanguage;
      clonedInstance._systemPrompt = this._systemPrompt;
      Logger.log(
        `${this._apiName}: Cloned instance (Source: ${this._sourceLanguage}, Target: ${this._targetLanguage}).`,
      );
      return clonedInstance;
    }

    async translate(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.translate must be a string.`,
        );
      }
      // Context is ignored for translate per spec understanding
      if (callOptions.context) {
        Logger.warn(`${this._apiName}.translate: 'context' option is ignored.`);
      }
      // Ensure response format is plain-text
      if (
        callOptions.responseFormat &&
        callOptions.responseFormat !== "plain-text"
      ) {
        Logger.warn(
          `${this._apiName}.translate: Overriding responseFormat "${callOptions.responseFormat}" with "plain-text".`,
        );
      }
      callOptions.responseFormat = "plain-text";

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: text }, // User input is the text to translate
      ];

      return this._performApiRequest({ messages, callOptions });
    }

    translateStreaming(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.translateStreaming must be a string.`,
        );
      }
      // Context is ignored
      if (callOptions.context) {
        Logger.warn(
          `${this._apiName}.translateStreaming: 'context' option is ignored.`,
        );
      }
      // Ensure response format is plain-text
      if (
        callOptions.responseFormat &&
        callOptions.responseFormat !== "plain-text"
      ) {
        Logger.warn(
          `${this._apiName}.translateStreaming: Overriding responseFormat "${callOptions.responseFormat}" with "plain-text".`,
        );
      }
      callOptions.responseFormat = "plain-text";

      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: text },
      ];

      // Translator streams raw text deltas (plain-text)
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: false, // Stream deltas
        // No specific onSuccess needed
      });
    }
  }

  class LanguageDetectorInstance extends BaseApiInstance {
    _expectedInputLanguages; // Array of BCP 47 codes

    constructor(apiKey, options = {}) {
      // Use 'LanguageDetector' for logging clarity
      super(
        "LanguageDetector",
        apiKey,
        Config.DEFAULT_LANGUAGE_DETECTOR_MODEL,
        options,
      );

      // Store and validate expectedInputLanguages if provided
      if (options.expectedInputLanguages) {
        if (
          !Array.isArray(options.expectedInputLanguages) ||
          options.expectedInputLanguages.some(
            (lang) => typeof lang !== "string",
          )
        ) {
          throw new TypeError(
            `${this._apiName}: 'expectedInputLanguages' must be an array of strings.`,
          );
        }
        this._expectedInputLanguages = [...options.expectedInputLanguages];
        Logger.log(
          `${this._apiName}: Instance created with ${this._expectedInputLanguages.length} expected languages. (Note: Emulator model may not actively use this hint).`,
        );
      } else {
        Logger.log(
          `${this._apiName}: Instance created without expected language hints.`,
        );
      }

      // Check for abort *after* initialization
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._combinedSignal.reason ||
          new DOMException("LanguageDetector creation aborted.", "AbortError")
        );
      }
      // LanguageDetector implies JSON output, warn if format option provided differently
      if (options.format && options.format !== "json") {
        Logger.warn(
          `${this._apiName}: 'format' option "${options.format}" provided at creation, but LanguageDetector always outputs JSON.`,
        );
      }
      // Set default format to json for this instance
      this._options.format = "json";
    }

    /**
     * Creates a clone of this language detector instance.
     * @returns {LanguageDetectorInstance} A new instance with the same configuration.
     */
    clone() {
      const clonedInstance = super.clone(); // Handles base options, api key, model
      // Copy derived state specific to LanguageDetector
      clonedInstance._expectedInputLanguages = this._expectedInputLanguages
        ? [...this._expectedInputLanguages]
        : undefined;
      Logger.log(`${this._apiName}: Cloned instance.`);
      return clonedInstance;
    }

    async detect(text, callOptions = {}) {
      if (typeof text !== "string") {
        throw new TypeError(
          `Input 'text' for ${this._apiName}.detect must be a string.`,
        );
      }
      // Context is ignored for detect per spec understanding
      if (callOptions.context) {
        Logger.warn(`${this._apiName}.detect: 'context' option is ignored.`);
      }

      // Ensure responseFormat is 'json' for the API call
      if (callOptions.responseFormat && callOptions.responseFormat !== "json") {
        Logger.warn(
          `${this._apiName}.detect: Overriding responseFormat "${callOptions.responseFormat}" with "json".`,
        );
      }
      callOptions.responseFormat = "json"; // Force JSON format

      // Construct messages for the model
      const messages = [
        { role: "system", content: Config.LANGUAGE_DETECTOR_SYSTEM_PROMPT },
        { role: "user", content: text }, // User input is the text to detect
      ];

      // Perform the API request, expecting a JSON string back
      const responseJsonString = await this._performApiRequest({
        messages,
        callOptions, // Pass through signal etc.
      });

      // --- Parse and Validate the JSON Response ---
      let results = [{ detectedLanguage: "und", confidence: 1.0 }]; // Default/fallback result

      if (!responseJsonString || typeof responseJsonString !== "string") {
        Logger.warn(
          `${this._apiName}: Received empty or non-string response from API. Using fallback result.`,
        );
        return results;
      }

      try {
        // _performApiRequest should have returned cleaned JSON string
        const parsed = JSON.parse(responseJsonString);

        // Validate the structure: Array of {detectedLanguage: string, confidence: number}
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              typeof item.detectedLanguage === "string" &&
              item.detectedLanguage.length > 0 && // Ensure non-empty language code
              typeof item.confidence === "number" &&
              item.confidence >= 0 &&
              item.confidence <= 1,
          )
        ) {
          // Sort by confidence (descending) and normalize
          results = parsed.sort((a, b) => b.confidence - a.confidence);
          results = Utils.normalizeConfidences(results); // Normalize confidence scores
        } else {
          // Log if structure is invalid but parsing succeeded
          Logger.warn(
            `${this._apiName}: Model response parsed as JSON but has invalid structure. Using fallback result. Response:`,
            parsed,
          );
          // Reset to fallback if structure is wrong
          results = [{ detectedLanguage: "und", confidence: 1.0 }];
        }
      } catch (parseError) {
        // Log if JSON parsing failed
        Logger.warn(
          `${this._apiName}: Failed to parse model JSON response. Using fallback result. Error:`,
          parseError.message,
          "Raw Response:",
          responseJsonString, // Log the raw string that failed parsing
        );
        // Reset to fallback on parse error
        results = [{ detectedLanguage: "und", confidence: 1.0 }];
      }

      return results; // Return validated, sorted, and normalized results or fallback
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
          writable: false, // Make the namespace itself non-writable
          configurable: true, // Allow potential redefinition if needed later (e.g., script update)
        });
        Logger.log(`Created global namespace '${nsName}'`);
      } catch (e) {
        Logger.error(`Failed to create global namespace '${nsName}':`, e);
        // Fallback if defineProperty fails (e.g., in very restricted environments)
        nsTarget[nsName] = nsTarget[nsName] || {};
      }
    }
    const aiNamespace = nsTarget[nsName];

    // Ensure pending promises object exists (used for early create calls)
    // Use a less common property name to avoid potential collisions
    const pendingKey = Symbol.for(Config.PENDING_PROMISES_KEY); // Use a Symbol
    nsTarget[pendingKey] = nsTarget[pendingKey] || {};

    // Factory for creating placeholder objects
    const createPlaceholder = (apiName, isStatic = false) => {
      const placeholder = {
        // availability: returns 'available' | 'downloadable' | 'unavailable'
        availability: async () => {
          const keyLoaded = await KeyManager.ensureApiKeyLoaded();
          // Static APIs (Translator, Detector) are 'available' if key exists.
          // Non-static (model, summarizer etc) require 'download' which we map to 'downloadable'.
          if (keyLoaded) {
            return isStatic ? "available" : "downloadable";
          } else {
            return "unavailable";
          }
        },
        // capabilities: returns object with API features
        capabilities: async () => {
          // Basic capabilities common to most emulated APIs
          const baseCapabilities = {
            available: (await KeyManager.ensureApiKeyLoaded())
              ? "readily"
              : "no",
            // Add other common capabilities if the spec defines them here
          };
          // Add API-specific capabilities later when the real API is initialized
          return baseCapabilities;
        },
        // create: returns a Promise that resolves with the API instance
        create: async (options = {}) => {
          // Check key availability *before* returning the promise
          if (!(await KeyManager.ensureApiKeyLoaded())) {
            Logger.error(
              `${apiName}.create called but API Key not configured.`,
            );
            // Throw immediately, matching expected behavior for unavailable API
            throw new APIError(
              `${apiName}: Cannot create instance, API Key is not configured.`,
              { name: "NotSupportedError" },
            ); // Use NotSupportedError? Or stick to APIError? Let's use APIError.
          }

          // Return a promise that will be resolved/rejected when initializeApis runs
          return new Promise((resolve, reject) => {
            // Store resolver/rejecter keyed by API name for later use
            nsTarget[pendingKey][apiName] = { resolve, reject, options };
            Logger.log(
              `${apiName}: Placeholder 'create' called, storing promise.`,
            );
          });
        },
      };
      // Add placeholder methods specific to certain APIs if needed
      if (apiName === "Translator" || apiName === "translator") {
        placeholder.languagePairAvailable = async (options = {}) => {
          // Basic check: requires key and valid options
          if (!options?.sourceLanguage || !options?.targetLanguage) {
            return "unavailable"; // Invalid options
          }
          return (await KeyManager.ensureApiKeyLoaded())
            ? "available"
            : "unavailable";
        };
      }

      return placeholder;
    };

    // Define APIs to create placeholders for
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
      // Static APIs (use standard capitalization as primary)
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
        // Ensure placeholder exists for the primary name (e.g., languageModel, Translator)
        if (!Object.prototype.hasOwnProperty.call(aiNamespace, name)) {
          aiNamespace[name] = createPlaceholder(name, isStatic);
          // Logger.log(`Created placeholder for ${name}`);
        }
        // Add lowercase aliases for convenience if different (e.g., translator, languageDetector)
        const lowerName = name.toLowerCase();
        if (
          name !== lowerName &&
          !Object.prototype.hasOwnProperty.call(aiNamespace, lowerName)
        ) {
          // Point the lowercase alias to the same placeholder object initially
          // The real implementation will handle both later.
          aiNamespace[lowerName] = aiNamespace[name];
          // Logger.log(`Aliased placeholder ${name} to ${lowerName}`);
        }
      }
    });

    Logger.log(`Placeholders ensured for enabled APIs.`);
  }

  // --- Main Initialization ---
  async function initializeApis() {
    await KeyManager.ensureApiKeyLoaded(); // Load key early

    // Register menu commands
    GM_registerMenuCommand(
      "Set OpenRouter API Key",
      KeyManager.promptForApiKey,
    );
    GM_registerMenuCommand("Clear OpenRouter API Key", () =>
      KeyManager.clearApiKey(true),
    ); // Ensure confirmation
    GM_registerMenuCommand(
      "Check OpenRouter Key Status",
      KeyManager.showKeyStatus,
    );

    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;
    const aiNamespace = nsTarget[nsName];
    const pendingKey = Symbol.for(Config.PENDING_PROMISES_KEY);
    const pendingPromises = nsTarget[pendingKey] || {};

    // Factory function to create the actual static API object
    const createApiStatic = (apiName, InstanceClass, isEnabled) => {
      if (!isEnabled) return null;

      // This object contains the static methods (`availability`, `capabilities`, `create`)
      const staticApi = {
        availability: async (/* options = {} */) => {
          // Availability depends only on the API key being set
          return (await KeyManager.ensureApiKeyLoaded())
            ? "available"
            : "unavailable";
          // Note: The original spec had 'downloadable' for non-static APIs.
          // We map that concept here based on InstanceClass type if needed,
          // but for the final API, it's just 'available' or 'unavailable'.
          // Let's align with the simpler 'available'/'unavailable' based on key.
        },
        capabilities: async () => {
          const keyLoaded = await KeyManager.ensureApiKeyLoaded();
          const baseCaps = {
            available: keyLoaded ? "readily" : "no",
            // Add capabilities common to most text models if applicable
            // These might vary greatly per model, so keep it simple or fetch dynamically?
            // Let's add the config defaults as potential indicators.
            defaultTemperature: Config.DEFAULT_TEMPERATURE,
            defaultTopK: Config.DEFAULT_TOP_K,
            maxTemperature: Config.MAX_TEMPERATURE,
            maxTopK: Config.MAX_TOP_K,
            // Input quota is instance-specific, maybe expose max context here?
            maxInputTokens: Config.MAX_CONTEXT_TOKENS, // Expose general limit
          };
          // Add API-specific capabilities if needed (handled by specialized creators below)
          return baseCaps;
        },
        create: async (options = {}) => {
          const apiKey = await KeyManager.ensureApiKeyLoaded();
          const pending = pendingPromises[apiName]; // Find pending promise using the exact apiName used in placeholder

          if (!apiKey) {
            const error = new APIError(
              `${apiName}: Cannot create instance, API Key is not configured.`,
            );
            pending?.reject?.(error); // Reject pending promise if any
            if (pending) delete pendingPromises[apiName]; // Clean up
            throw error; // Throw error for direct calls
          }

          try {
            // Instantiate the specific API class (e.g., LanguageModelSession)
            const instance = new InstanceClass(apiKey, options);
            pending?.resolve?.(instance); // Resolve pending promise
            Logger.log(`${apiName}: Instance created successfully.`);
            return instance; // Return instance for direct calls
          } catch (error) {
            Logger.error(`${apiName}: Error during instance creation:`, error);
            pending?.reject?.(error); // Reject pending promise with creation error
            // Re-throw the error so the caller knows creation failed
            // Ensure it's an error object
            if (!(error instanceof Error)) {
              throw new APIError(`Instance creation failed: ${error}`, {
                cause: error,
              });
            }
            throw error;
          } finally {
            // Clean up the pending promise entry regardless of success/failure
            if (pending && pendingPromises[apiName]) {
              delete pendingPromises[apiName];
            }
          }
        },
      };
      return staticApi;
    };

    // Specialized creator for Translator to add languagePairAvailable
    const createTranslatorApi = (apiName, InstanceClass, isEnabled) => {
      if (!isEnabled) return null;
      const baseApi = createApiStatic(apiName, InstanceClass, isEnabled);

      if (baseApi) {
        // Add translator-specific capabilities function
        const originalCapabilities = baseApi.capabilities;
        baseApi.capabilities = async () => {
          const caps = await originalCapabilities();
          // Add the function itself to capabilities, as per spec examples
          caps.languagePairAvailable = baseApi.languagePairAvailable; // Add the method reference
          return caps;
        };

        // Implement languagePairAvailable static method
        baseApi.languagePairAvailable = async (options = {}) => {
          if (
            typeof options.sourceLanguage !== "string" ||
            !options.sourceLanguage ||
            typeof options.targetLanguage !== "string" ||
            !options.targetLanguage
          ) {
            // Spec says return "unavailable" for invalid input
            return "unavailable";
          }
          // For this emulator, we assume any pair is available if the key is set.
          // A real implementation might check model capabilities.
          return (await KeyManager.ensureApiKeyLoaded())
            ? "available"
            : "unavailable";
        };
      }
      return baseApi;
    };

    // --- Define API Implementations ---
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
      // Static APIs (use standard capitalization)
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

    // --- Assign Implementations to Namespace ---
    apiDefinitions.forEach(({ name, InstanceClass, enabled, apiCreator }) => {
      if (enabled) {
        const staticApiImpl = apiCreator(name, InstanceClass, enabled);
        if (staticApiImpl) {
          // Ensure the object exists in the namespace (might be placeholder)
          if (!aiNamespace[name]) aiNamespace[name] = {};
          // Assign the actual implementation methods over the placeholder
          Object.assign(aiNamespace[name], staticApiImpl);
          Logger.log(`Initialized API: ${name}`);

          // Handle lowercase alias if different
          const lowerName = name.toLowerCase();
          if (name !== lowerName) {
            const staticApiLowerImpl = apiCreator(
              lowerName,
              InstanceClass,
              enabled,
            ); // Create specific static methods for lowercase name
            if (staticApiLowerImpl) {
              if (!aiNamespace[lowerName]) aiNamespace[lowerName] = {};
              Object.assign(aiNamespace[lowerName], staticApiLowerImpl);
              Logger.log(`Initialized API alias: ${lowerName}`);
            }
          }
        }
      } else {
        // If API is disabled, ensure it's removed or explicitly marked unavailable
        if (aiNamespace[name]) {
          aiNamespace[name].availability = async () => "unavailable";
          aiNamespace[name].capabilities = async () => ({ available: "no" });
          aiNamespace[name].create = async () => {
            throw new APIError(`${name} API is disabled in configuration.`, {
              name: "NotSupportedError",
            });
          };
          Logger.log(`API explicitly disabled: ${name}`);
        }
        const lowerName = name.toLowerCase();
        if (name !== lowerName && aiNamespace[lowerName]) {
          aiNamespace[lowerName].availability = async () => "unavailable";
          aiNamespace[lowerName].capabilities = async () => ({
            available: "no",
          });
          aiNamespace[lowerName].create = async () => {
            throw new APIError(
              `${lowerName} API is disabled in configuration.`,
              { name: "NotSupportedError" },
            );
          };
          Logger.log(`API alias explicitly disabled: ${lowerName}`);
        }
      }
    });

    // --- Final Logging and Cleanup ---
    let logMessage = `Chrome AI API emulator (v${GM_info.script.version}) initialized.`;
    const enabledApiNames = apiDefinitions
      .filter((api) => api.enabled)
      .map((api) => api.name); // Use primary names
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

    // Check API key status post-initialization
    if (!openRouterApiKey) {
      Logger.warn(
        `OpenRouter API Key is not set. Use the Tampermonkey menu ('Set OpenRouter API Key') to configure it. All API calls will fail until a key is provided.`,
      );
      // Reject any remaining pending promises due to missing key
      Object.entries(pendingPromises).forEach(([apiName, { reject }]) => {
        if (reject)
          reject(
            new APIError(
              `${apiName}: API key not configured at initialization.`,
            ),
          );
      });
    } else {
      Logger.log(`OpenRouter API Key loaded and ready.`);
      // Key is loaded, but don't automatically resolve pending promises here.
      // The 'create' method handles resolving them when called.
    }

    // Clean up the pending promises tracking object from the global scope
    if (nsTarget[pendingKey]) {
      // Optionally null out resolvers/rejectors to prevent leaks if script is updated live
      Object.values(nsTarget[pendingKey]).forEach((p) => {
        p.resolve = null;
        p.reject = null;
      });
      delete nsTarget[pendingKey]; // Remove the tracking object
      Logger.log(`Cleaned up pending promise tracking.`);
    }
  }

  // --- Script Execution Start ---

  // 1. Setup Placeholders Immediately (at document-start)
  try {
    setupPlaceholders();
  } catch (e) {
    console.error(
      `[${Config.EMULATED_NAMESPACE}] FATAL ERROR during placeholder setup:`,
      e,
    );
    // Cannot use Logger here as it might not be initialized
    alert(
      `Chrome AI Emulator: Fatal error during initial setup. Check console. Error: ${e.message}`,
    );
    return; // Stop script execution if placeholders fail
  }

  // 2. Initialize Full APIs after DOMContentLoaded
  function runInitialization() {
    initializeApis().catch(handleInitError);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runInitialization);
  } else {
    // DOM already loaded or interactive
    runInitialization();
  }

  // Error handler for the main initialization phase
  function handleInitError(error) {
    Logger.error(`Fatal error during API initialization:`, error);
    alert(
      `Chrome AI Emulator: Failed to initialize APIs. Check console for details. Error: ${error.message}`,
    );
    // Mark APIs as unavailable if init fails?
    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;
    if (nsTarget[nsName]) {
      Object.keys(nsTarget[nsName]).forEach((apiKey) => {
        if (
          nsTarget[nsName][apiKey] &&
          typeof nsTarget[nsName][apiKey] === "object"
        ) {
          nsTarget[nsName][apiKey].availability = async () => "unavailable";
          nsTarget[nsName][apiKey].capabilities = async () => ({
            available: "no",
          });
          nsTarget[nsName][apiKey].create = async () => {
            throw new APIError(`API initialization failed: ${error.message}`);
          };
        }
      });
      Logger.warn(
        "Marked all emulated APIs as unavailable due to initialization error.",
      );
    }
  }
})();
