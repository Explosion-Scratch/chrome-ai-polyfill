// ==UserScript==
// @name        Chrome AI APIs Emulator (via OpenRouter)
// @namespace   mailto:explosionscratch@gmail.com
// @version     3.1
// @description Emulates experimental Chrome AI APIs (Prompt, Writing Assistance, Translation, Language Detection) using OpenRouter.
// @author      Explosion Implosion (Refactored with AI assistance)
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       unsafeWindow
// @grant       GM_registerMenuCommand
// @grant       GM.xmlHttpRequest
// @require     https://cdn.jsdelivr.net/npm/@trim21/gm-fetch
// @connect     openrouter.ai
// @run-at      document-start
// ==/UserScript==

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
    RATE_DEBOUNCE: 5000, // Debounce time in milliseconds
    RATE_REQUESTS_PER_WINDOW: 10, // Maximum number of requests per window
    RATE_REQUEST_WINDOW: 30000, // Window size in milliseconds (30 seconds)

    // OpenRouter Request Headers
    YOUR_SITE_URL: "about:blank", // Recommended: Replace with your specific site if applicable
    YOUR_APP_NAME: "ChromeAI_API_Emulator_v3.1",

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
        throw new APIError(
          `Rate limit exceeded. Maximum ${this.maxRequests} requests per ${this.windowMs / 1000} seconds.`,
        );
      }
      
      // Store for pending promises with their resolvers/rejecters
      if (!this.pendingPromises) {
        this.pendingPromises = new Map();
      }
      
      // If we already have a pending promise for this key, return it
      // but update the function arguments to the latest ones
      if (this.pendingPromises.has(key)) {
        const pendingInfo = this.pendingPromises.get(key);
        pendingInfo.latestArgs = args; // Update to use the latest arguments
        pendingInfo.latestFn = fn;     // Use the latest function
        return pendingInfo.promise;     // Return the existing promise
      }
      
      // Create a new promise for this operation
      const promise = new Promise((resolve, reject) => {
        const executeLatestCall = () => {
          try {
            const pendingInfo = this.pendingPromises.get(key);
            if (!pendingInfo) return; // Safety check
            
            // Get the latest arguments and function reference
            const latestArgs = pendingInfo.latestArgs;
            const latestFn = pendingInfo.latestFn;
            
            // Record the request and execute with latest args
            this.recordRequest();
            const result = latestFn(...latestArgs);
            resolve(result);
          } catch (error) {
            reject(error);
          } finally {
            // Clean up
            this.pendingPromises.delete(key);
            this.debounceTimers.delete(key);
          }
        };
        
        // Store the promise info
        this.pendingPromises.set(key, {
          promise,
          latestArgs: args,
          latestFn: fn,
          resolve,
          reject
        });
        
        // Clear any existing timer
        if (this.debounceTimers.has(key)) {
          clearTimeout(this.debounceTimers.get(key));
        }
        
        // Set a timer to execute after the debounce period
        const timerId = setTimeout(executeLatestCall, this.debounceMs);
        this.debounceTimers.set(key, timerId);
      });
      
      return promise;
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
      console.groupCollapsed(
        `[${Config.EMULATED_NAMESPACE}] API Call: ${apiName} - Prompt Details`,
      );
      console.log("Messages:", messages);
      console.groupEnd();
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
    /** Converts BCP 47 language tag to human-readable language name. */
    languageTagToHumanReadable: function (languageTag, displayLanguage = "en") {
      try {
        const displayNames = new Intl.DisplayNames([displayLanguage], {
          type: "language",
        });
        return displayNames.of(languageTag);
      } catch (e) {
        Logger.warn(
          `Could not convert language tag ${languageTag} to human-readable form:`,
          e,
        );
        return languageTag; // Fallback to original tag
      }
    },

    /** Normalizes confidence values in language detection results so they sum to 1.0 */
    normalizeConfidences: function (results) {
      if (!Array.isArray(results) || results.length === 0) return results;

      const sum = results.reduce((acc, item) => acc + item.confidence, 0);
      if (sum === 0) return results; // Avoid division by zero

      return results.map((item) => ({
        ...item,
        confidence: Math.round((item.confidence / sum) * 1000) / 1000, // Round to 3 decimal places
      }));
    },

    /** Checks for CSP blockage using fetch and SecurityPolicyViolationEvent. @async */
    isBlocked: async function (domain, timeout = 500) {
      const normalizedDomain = domain
        .replace(/^(https?:\/\/)?/, "")
        .split("/")[0];
      const testUrl = `https://${normalizedDomain}/`;
      return new Promise((resolve) => {
        let violationDetected = false;
        let timerId = null;
        const listener = (event) => {
          if (
            event.blockedURI.includes(normalizedDomain) &&
            (event.violatedDirective.startsWith("connect-src") ||
              event.violatedDirective.startsWith("default-src"))
          ) {
            violationDetected = true;
            clearTimeout(timerId);
            document.removeEventListener("securitypolicyviolation", listener);
            resolve(true);
          }
        };
        document.addEventListener("securitypolicyviolation", listener);
        fetch(testUrl, { method: "HEAD", mode: "no-cors", cache: "no-store" })
          .then((response) => {
            // Logger.log(`CSP Check: Fetch attempt to ${testUrl} allowed (status: ${response.status}).`);
          })
          .catch((error) => {
            // Rely primarily on the event
          });
        timerId = setTimeout(() => {
          if (!violationDetected) {
            document.removeEventListener("securitypolicyviolation", listener);
            resolve(false);
          }
        }, timeout);
      });
    },

    /** Estimates token count (simple char-based). */
    tokenize: (text) =>
      text ? Math.ceil(text.length / Config.TOKEN_CHAR_RATIO) : 0,

    /** Calculates total tokens for an array of messages. */
    calculateTotalTokens: (messages) =>
      messages.reduce((sum, msg) => sum + Utils.tokenize(msg.content), 0),

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
            if (delta) chunks.push(delta);
          } catch (e) {
            Logger.error(`Error parsing SSE chunk:`, dataContent, e);
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
        });
      }

      let streamController;
      let requestAbortedOrFinished = false;

      const stream = new ReadableStream({
        start: async (controller) => {
          streamController = controller;

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
            streamController.error(error);
            return;
          }

          // 2. Call API
          try {
            await CoreAPI.askOpenRouter({
              apiName, // Pass apiName for logging
              apiKey,
              messages,
              model,
              parameters,
              stream: true,
              signal,
              on: {
                chunk: (delta, acc) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  try {
                    // Enqueue accumulated text or just the delta based on 'accumulated' flag
                    streamController.enqueue(accumulated ? acc : delta);
                  } catch (e) {
                    Logger.error(`${apiName}: Error enqueuing chunk:`, e);
                    requestAbortedOrFinished = true;
                    try {
                      streamController.error(e);
                    } catch (_) {}
                  }
                },
                finish: (/* fullMessage */) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  requestAbortedOrFinished = true;
                  Logger.log(`${apiName}: Streaming finished.`);
                  try {
                    streamController.close();
                    onSuccess?.();
                  } catch (_) {
                    /* Might already be closed/errored */
                  }
                },
                error: (error) => {
                  if (requestAbortedOrFinished || !streamController) return;
                  requestAbortedOrFinished = true;
                  Logger.error(`${apiName}: Streaming error received:`, error);
                  try {
                    streamController.error(error);
                  } catch (_) {}
                },
              },
            });
          } catch (error) {
            if (!requestAbortedOrFinished && streamController) {
              requestAbortedOrFinished = true;
              Logger.error(
                `${apiName}: Error during streaming setup/request:`,
                error,
              );
              try {
                streamController.error(error);
              } catch (_) {}
            } else if (!streamController) {
              Logger.error(
                `${apiName}: Stream controller unavailable during error:`,
                error,
              );
            }
          }
        },
        cancel: (reason) => {
          Logger.log(
            `${apiName}: Stream cancelled by consumer. Reason:`,
            reason,
          );
          requestAbortedOrFinished = true;
        },
      });
      return stream;
    },

    /** Simulates the download progress events for the monitor callback. */
    simulateMonitorEvents: (monitorCallback) => {
      if (typeof monitorCallback !== "function") return;
      try {
        const monitorTarget = {
          addEventListener: (type, listener) => {
            if (type === "downloadprogress" && typeof listener === "function") {
              setTimeout(
                () =>
                  listener(
                    new ProgressEvent("downloadprogress", {
                      loaded: 0,
                      total: 1,
                    }),
                  ),
                5,
              );
              setTimeout(
                () =>
                  listener(
                    new ProgressEvent("downloadprogress", {
                      loaded: 1,
                      total: 1,
                    }),
                  ),
                10,
              );
            }
          },
        };
        monitorCallback(monitorTarget);
      } catch (e) {
        Logger.error(`Error calling monitor function:`, e);
      }
    },
  };

  let _fetch = window.fetch;
  Utils.isBlocked(new URL(Config.OPENROUTER_API_BASE_URL).hostname).then(
    (blocked) => {
      if (blocked) {
        if (typeof GM_fetch === "function") {
          Logger.log(`Using GM_fetch due to potential CSP.`);
          _fetch = GM_fetch;
        } else {
          Logger.warn(
            `GM_fetch not found, using window.fetch despite potential CSP issues.`,
          );
        }
      }
    },
  );

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

      const internalController = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any([signal, internalController.signal])
        : internalController.signal;
      let abortReason = null;
      const abortHandler = (event) => {
        abortReason =
          event?.reason ?? new DOMException("Operation aborted.", "AbortError");
        if (!internalController.signal.aborted) {
          internalController.abort(abortReason);
        }
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      // Log the prompt before fetching
      Logger.logPrompt(apiName, messages);

      return new Promise(async (resolve, reject) => {
        let accumulatedResponse = "";
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
            requestOptions,
          );

          if (!response.ok) {
            let errorText = `API Error ${response.status}`;
            let errorDetail = "";
            try {
              const bodyText = await response.text();
              errorText = `${errorText}: ${bodyText.substring(0, 150)}`;
              try {
                const jsonError = JSON.parse(bodyText);
                errorDetail =
                  jsonError?.error?.message || bodyText.substring(0, 100);
              } catch {
                errorDetail = bodyText.substring(0, 100);
              }
            } catch (_) {
              /* Ignore body reading errors */
            }
            const error = new APIError(
              `${apiName}: ${errorDetail || `OpenRouter request failed with status ${response.status}`}`,
              { status: response.status },
            );
            on?.error?.(error);
            reject(error);
            return;
          }

          if (stream) {
            if (!response.body)
              throw new APIError("Response body is null for stream.");
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

              if (combinedSignal.aborted) {
                const error =
                  abortReason ??
                  new DOMException(
                    "Operation aborted during stream processing.",
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
                if (buffer.trim())
                  Logger.warn(`Remaining buffer at stream end:`, buffer);
                on?.finish?.(accumulatedResponse);
                resolve(accumulatedResponse);
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const eventMessages = buffer.split("\n\n");
              buffer = eventMessages.pop() || "";

              for (const sseMessage of eventMessages) {
                if (sseMessage.trim()) {
                  const deltas = Utils.parseSSE(sseMessage + "\n\n");
                  deltas.forEach((delta) => {
                    accumulatedResponse += delta;
                    on?.chunk?.(delta, accumulatedResponse);
                  });
                }
              }
            }
          } else {
            const jsonResponse = await response.json();
            const content = jsonResponse?.choices?.[0]?.message?.content;
            if (typeof content === "string") {
              accumulatedResponse = content;
              on?.finish?.(content);
              resolve(content);
            } else {
              Logger.error(
                `Invalid non-streaming response structure:`,
                jsonResponse,
              );
              throw new APIError(
                `${apiName}: Invalid response structure from OpenRouter.`,
              );
            }
          }
        } catch (error) {
          let finalError = error;
          if (error.name === "AbortError" || combinedSignal.aborted) {
            finalError =
              abortReason ??
              new DOMException("Operation aborted.", "AbortError", {
                cause: combinedSignal.reason ?? error,
              });
          } else if (
            !(error instanceof APIError || error instanceof QuotaExceededError)
          ) {
            Logger.error(`Unexpected error during API call:`, error);
            finalError = new APIError(
              `${apiName}: Network or processing error: ${error.message}`,
              { cause: error },
            );
          }
          on?.error?.(finalError);
          reject(finalError);
        } finally {
          if (!internalController.signal.aborted) {
            internalController.abort(
              new DOMException("Operation finished or errored.", "AbortError"),
            );
          }
          signal?.removeEventListener("abort", abortHandler);
        }
      });
    },

    /**
     * Central function to make rate-limited requests to OpenRouter
     * Uses the rate limiter to debounce and limit requests
     */
    askOpenRouter: async ({
      apiName, // Added for logging
      apiKey,
      messages,
      model,
      parameters,
      stream = false,
      signal,
      on,
    }) => {
      // Generate a unique key for this request for debouncing
      // Using apiName and a hash of the stringified messages for uniqueness
      const requestKey = `${apiName}-${JSON.stringify(messages).length}`;

      try {
        // Use the rate limiter to perform the request with debouncing
        return await apiRateLimiter.execute(
          // Passing the actual API request function to execute after debouncing
          () =>
            CoreAPI._rawApiRequest({
              apiName,
              apiKey,
              messages,
              model,
              parameters,
              stream,
              signal,
              on,
            }),
          requestKey,
        );
      } catch (error) {
        // If rate limit was exceeded, notify
        if (
          error instanceof APIError &&
          error.message.includes("Rate limit exceeded")
        ) {
          Logger.warn(`${apiName}: ${error.message}`);
          on?.error?.(error);
        }
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
        await KeyManager.clearApiKey(false);
      } else if (newKey !== "" && newKey !== currentKey) {
        await GM_setValue(Config.API_KEY_STORAGE_KEY, newKey);
        openRouterApiKey = newKey;
        alert("API Key saved. Reload page to apply changes.");
      }
    },
    clearApiKey: async (confirmFirst = true) => {
      if (
        !openRouterApiKey &&
        !(await GM_getValue(Config.API_KEY_STORAGE_KEY))
      ) {
        alert("No API key stored.");
        return;
      }
      const confirmed =
        !confirmFirst || confirm("Clear stored OpenRouter API Key?");
      if (confirmed) {
        await GM_deleteValue(Config.API_KEY_STORAGE_KEY);
        openRouterApiKey = null;
        alert("API Key cleared. Reload page.");
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
        alert("OpenRouter API Key needed. Set via menu.");
        return null;
      }
      try {
        const response = await _fetch(Config.OPENROUTER_KEY_CHECK_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": Config.YOUR_SITE_URL,
            "X-Title": Config.YOUR_APP_NAME,
          },
        });
        if (!response.ok) {
          const errorText = await response.text();
          alert(
            `Error fetching key details (${response.status}): ${errorText.substring(0, 200)}`,
          );
          Logger.error(`API key check failed ${response.status}:`, errorText);
          return null;
        }
        const data = await response.json();
        return data?.data;
      } catch (error) {
        alert(`Network error fetching key details: ${error.message}`);
        Logger.error(`Network error during key check:`, error);
        return null;
      }
    },
    showKeyStatus: async () => {
      const details = await KeyManager.getOpenRouterKeyDetails();
      if (details) {
        const formatCurrency = (val) =>
          val !== undefined && val !== null
            ? `$${Number(val).toFixed(4)}`
            : "N/A";
        const usage = formatCurrency(details.usage);
        const limit = formatCurrency(details.limit);
        const remaining = formatCurrency(details.limit_remaining);
        const reqLimit = details.rate_limit?.requests ?? "N/A";
        const interval = details.rate_limit?.interval ?? "N/A";
        alert(
          `OpenRouter Key:\nLabel: ${details.label || "N/A"}\nUsage: ${usage}\nLimit: ${limit}\nRemaining: ${remaining}\nRate: ${reqLimit} req / ${interval}\nFree Tier: ${details.is_free_tier ? "Yes" : "No"}`,
        );
      }
    },
  };

  // --- API Implementation Helpers ---

  class BaseApiInstance {
    _apiKey;
    _model;
    _options;
    _instanceAbortController;
    _creationSignal;
    _combinedSignal;
    _apiName;
    constructor(apiName, apiKey, defaultModel, options = {}) {
      this._apiName = apiName;
      this._apiKey = apiKey;
      this._model = defaultModel;
      this._options = { ...options };
      this._creationSignal = options.signal;
      this._instanceAbortController = new AbortController();
      this._combinedSignal = options.signal
        ? AbortSignal.any([
            options.signal,
            this._instanceAbortController.signal,
          ])
        : this._instanceAbortController.signal;
      Utils.simulateMonitorEvents(options.monitor);
      if (options.expectedContextLanguages || options.outputLanguage) {
        Logger.warn(
          `${apiName}: Language options (expectedContextLanguages, outputLanguage) are ignored by this emulator.`,
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
      // By default, just create a new instance with the same options
      const clonedInstance = new this.constructor(this._apiKey, {
        ...this._options,
      });
      return clonedInstance;
    }
    get inputQuota() {
      return Config.MAX_CONTEXT_TOKENS;
    }
    async measureInputUsage(text) {
      return Promise.resolve(Utils.tokenize(text));
    }
    destroy() {
      Logger.log(`${this._apiName}: Instance destroy() called.`);
      if (!this._instanceAbortController.signal.aborted) {
        this._instanceAbortController.abort(
          new DOMException(
            `${this._apiName} instance destroyed.`,
            "AbortError",
          ),
        );
      }
    }
    async _performApiRequest({ messages, callOptions = {}, parameters = {} }) {
      const operationSignal = callOptions.signal
        ? AbortSignal.any([this._combinedSignal, callOptions.signal])
        : this._combinedSignal;
      if (operationSignal.aborted) {
        throw (
          operationSignal.reason ??
          new DOMException(
            `${this._apiName} operation aborted before start.`,
            "AbortError",
            { cause: operationSignal.reason },
          )
        );
      }
      const totalTokens = Utils.calculateTotalTokens(messages);
      if (totalTokens > this.inputQuota) {
        throw new QuotaExceededError(
          `${this._apiName}: Input exceeds token limit.`,
          { requested: totalTokens, quota: this.inputQuota },
        );
      }
      try {
        let requestError = null;
        const result = await CoreAPI.askOpenRouter({
          apiName: this._apiName,
          apiKey: this._apiKey,
          messages,
          model: this._model,
          parameters,
          stream: false,
          signal: operationSignal,
          on: {
            finish: (msg) =>
              Logger.log(`${this._apiName}: Non-streaming request finished.`),
            error: (err) => {
              Logger.error(
                `${this._apiName}: Error during non-streaming request:`,
                err,
              );
              requestError = err;
            },
          },
        });
        if (requestError) throw requestError;
        return result;
      } catch (error) {
        if (error.name === "AbortError" || operationSignal.aborted) {
          throw operationSignal.reason ?? error;
        }
        if (error instanceof QuotaExceededError || error instanceof APIError) {
          throw error;
        }
        Logger.error(
          `${this._apiName}: Unexpected error performing API request:`,
          error,
        );
        throw new APIError(
          `${this._apiName}: Failed to complete operation. ${error.message}`,
          { cause: error },
        );
      }
    }
    _performApiStreamingRequest({
      messages,
      callOptions = {},
      parameters = {},
      accumulated = false,
      onSuccess,
    }) {
      const operationSignal = callOptions.signal
        ? AbortSignal.any([this._combinedSignal, callOptions.signal])
        : this._combinedSignal;
      return Utils.createApiReadableStream({
        apiName: this._apiName,
        apiKey: this._apiKey,
        model: this._model,
        messages,
        parameters,
        signal: operationSignal,
        accumulated,
        onSuccess,
      });
    }
  }

  // --- API Implementations ---

  class LanguageModelSession extends BaseApiInstance {
    _history;
    _parameters;
    constructor(apiKey, options = {}) {
      super("languageModel", apiKey, Config.DEFAULT_PROMPT_MODEL, options);
      // Accept temperature, topK (as topP in the API), and systemPrompt directly from options
      this._parameters = {
        temperature:
          options.temperature !== undefined
            ? options.temperature
            : Config.DEFAULT_TEMPERATURE,
        topK: options.topK !== undefined ? options.topK : Config.DEFAULT_TOP_K,
      };
      // Temperature validation
      if (this._parameters.temperature > Config.MAX_TEMPERATURE) {
        Logger.warn(
          `languageModel: temperature ${this._parameters.temperature} exceeds maximum of ${Config.MAX_TEMPERATURE}. Using maximum.`,
        );
        this._parameters.temperature = Config.MAX_TEMPERATURE;
      }
      // TopK validation
      if (this._parameters.topK > Config.MAX_TOP_K) {
        Logger.warn(
          `languageModel: topK ${this._parameters.topK} exceeds maximum of ${Config.MAX_TOP_K}. Using maximum.`,
        );
        this._parameters.topK = Config.MAX_TOP_K;
      }

      this._history = this._initializeHistory(options);
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._creationSignal?.reason ??
          new DOMException("languageModel creation aborted.", "AbortError", {
            cause: this._creationSignal?.reason,
          })
        );
      }
    }
    _initializeHistory(options) {
      const history = [];
      const initial = options.initialPrompts;
      if (
        initial &&
        (!Array.isArray(initial) ||
          initial.some((p) => typeof p !== "object" || !p.role || !p.content))
      ) {
        throw new TypeError("Invalid initialPrompts format.");
      }
      const systemInInitial = initial?.find((p) => p.role === "system");
      if (options.systemPrompt && systemInInitial) {
        throw new TypeError(
          "Cannot provide both systemPrompt option and system role in initialPrompts.",
        );
      }
      if (systemInInitial && initial[0].role !== "system") {
        throw new TypeError(
          "System role message must be first in initialPrompts.",
        );
      }
      if (options.systemPrompt) {
        history.push({ role: "system", content: options.systemPrompt });
      }
      if (initial) {
        history.push(...initial);
      }
      return history;
    }
    _parseInput(input) {
      if (typeof input === "string") return [{ role: "user", content: input }];
      if (Array.isArray(input)) {
        if (
          input.some(
            (msg) => typeof msg !== "object" || !msg.role || !msg.content,
          )
        ) {
          throw new TypeError("Input message array needs {role, content}.");
        }
        return input;
      }
      throw new TypeError("Input must be string or message array.");
    }

    // Helper method to prepare parameters for API requests, applying per-call options if provided
    _prepareParameters(callOptions) {
      // Start with session-level parameters
      const parameters = { ...this._parameters };

      // Apply per-call parameters if provided
      if (callOptions.temperature !== undefined) {
        parameters.temperature = callOptions.temperature;
        // Validate temperature
        if (parameters.temperature > Config.MAX_TEMPERATURE) {
          Logger.warn(
            `languageModel: temperature ${parameters.temperature} exceeds maximum of ${Config.MAX_TEMPERATURE}. Using maximum.`,
          );
          parameters.temperature = Config.MAX_TEMPERATURE;
        }
      }

      if (callOptions.topK !== undefined) {
        parameters.topK = callOptions.topK;
        // Validate topK
        if (parameters.topK > Config.MAX_TOP_K) {
          Logger.warn(
            `languageModel: topK ${parameters.topK} exceeds maximum of ${Config.MAX_TOP_K}. Using maximum.`,
          );
          parameters.topK = Config.MAX_TOP_K;
        }
      }

      return parameters;
    }

    // Helper method to prepare messages array, considering system prompt in options
    _prepareMessages(input, callOptions) {
      const currentUserMessages = this._parseInput(input);
      let messagesForApi = [...this._history];

      // If a per-call systemPrompt is provided, insert it at the beginning (replacing any existing system prompt)
      if (callOptions.systemPrompt !== undefined) {
        // Remove any existing system message at the start of history or messages
        if (messagesForApi.length > 0 && messagesForApi[0].role === "system") {
          messagesForApi = messagesForApi.slice(1);
        }

        // Add the new system prompt
        messagesForApi.unshift({
          role: "system",
          content: callOptions.systemPrompt,
        });
      }

      // Add the user messages
      messagesForApi.push(...currentUserMessages);

      return { messagesForApi, currentUserMessages };
    }
    async prompt(input, callOptions = {}) {
      const { messagesForApi, currentUserMessages } = this._prepareMessages(
        input,
        callOptions,
      );
      const parameters = this._prepareParameters(callOptions);

      const assistantResponse = await this._performApiRequest({
        messages: messagesForApi,
        callOptions,
        parameters,
      });

      this._history.push(...currentUserMessages, {
        role: "assistant",
        content: assistantResponse,
      });
      Logger.log(`languageModel: prompt history updated.`);
      return assistantResponse;
    }
    promptStreaming(input, callOptions = {}) {
      const { messagesForApi, currentUserMessages } = this._prepareMessages(
        input,
        callOptions,
      );
      const parameters = this._prepareParameters(callOptions);

      let fullResponse = ""; // Needed for history update
      return this._performApiStreamingRequest({
        messages: messagesForApi,
        callOptions,
        parameters,
        accumulated: false,
        onSuccess: () => {
          // Spec is unclear how history is updated on streaming.
          // Assuming update after stream completion IF we could capture fullResponse.
          // This is a limitation in the current ReadableStream handling.
          // Logger.warn(`languageModel: History update for promptStreaming is currently approximate.`);
          // This._history.push(...currentUserMessages, { role: "assistant", content: "<STREAMED_RESPONSE_PLACEHOLDER>" });

          // For now, only log the user messages added before the stream started
          this._history.push(...currentUserMessages);
          Logger.log(
            `languageModel: promptStreaming user history updated. Assistant response not added.`,
          );
        },
      });
    }
    // Implementation for countPromptTokens
    async countPromptTokens(prompt) {
      try {
        const messagesToCount = this._parseInput(prompt);
        const tokenCount = Utils.calculateTotalTokens(messagesToCount);
        return Promise.resolve(tokenCount);
      } catch (error) {
        Logger.error("countPromptTokens error:", error);
        // Re-throw or return an error indicator, depending on spec.
        // Let's re-throw TypeErrors from parsing.
        if (error instanceof TypeError) {
          throw error;
        }
        // For other errors, maybe return -1 or throw a generic error?
        // Throwing seems more appropriate.
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
      // Create a new instance with the same options
      const clonedInstance = super.clone();

      // Copy parameters
      clonedInstance._parameters = { ...this._parameters };

      // Deep copy of history (clone all messages)
      clonedInstance._history = this._history.map((msg) => ({ ...msg }));

      Logger.log(
        `${this._apiName}: Cloned instance with ${clonedInstance._history.length} history items`,
      );
      return clonedInstance;
    }
  }

  class SummarizerInstance extends BaseApiInstance {
    _systemPrompt;
    constructor(apiKey, options = {}) {
      super("summarizer", apiKey, Config.DEFAULT_SUMMARIZER_MODEL, options);
      const type = options.type ?? "key-points";
      const format = options.format ?? "markdown"; // Summarizer uses format
      const length = options.length ?? "medium";
      const sharedContextSection = Utils.formatSharedContext(
        options.sharedContext,
      );
      this._systemPrompt = Config.SUMMARIZER_SYSTEM_PROMPT.replace(
        "{type}",
        type,
      )
        .replace("{format}", format)
        .replace("{length}", length)
        .replace("{sharedContextSection}", sharedContextSection);
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._creationSignal?.reason ??
          new DOMException("summarizer creation aborted.", "AbortError", {
            cause: this._creationSignal?.reason,
          })
        );
      }
    }

    /**
     * Creates a clone of this summarizer instance with the same configuration.
     * @returns {SummarizerInstance} A new instance with the same configuration
     */
    clone() {
      // Create a new instance with the same options
      const clonedInstance = super.clone();

      // Copy system prompt
      clonedInstance._systemPrompt = this._systemPrompt;

      Logger.log(
        `${this._apiName}: Cloned instance with same system prompt configuration`,
      );
      return clonedInstance;
    }
    async summarize(text, callOptions = {}) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be a string.");
      let userPromptContent = `Summarize the text:\n\`\`\`\n${text}\n\`\`\``;
      if (callOptions.context?.trim()) {
        userPromptContent += `\n\nContext:\n${callOptions.context.trim()}`;
      }
      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];
      return this._performApiRequest({ messages, callOptions });
    }
    summarizeStreaming(text, callOptions = {}) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be a string.");
      let userPromptContent = `Summarize the text:\n\`\`\`\n${text}\n\`\`\``;
      if (callOptions.context?.trim()) {
        userPromptContent += `\n\nContext:\n${callOptions.context.trim()}`;
      }
      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];
      // Summarizer streams deltas according to latest spec understanding
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: false,
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
      // Note: Writer does NOT use 'format' like Summarizer
      this._systemPrompt = Config.WRITER_SYSTEM_PROMPT.replace("{tone}", tone)
        .replace("{length}", length)
        .replace("{sharedContextSection}", sharedContextSection);
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._creationSignal?.reason ??
          new DOMException("writer creation aborted.", "AbortError", {
            cause: this._creationSignal?.reason,
          })
        );
      }
    }

    /**
     * Creates a clone of this writer instance with the same configuration.
     * @returns {WriterInstance} A new instance with the same configuration
     */
    clone() {
      // Create a new instance with the same options
      const clonedInstance = super.clone();

      // Copy system prompt
      clonedInstance._systemPrompt = this._systemPrompt;

      Logger.log(
        `${this._apiName}: Cloned instance with same system prompt configuration`,
      );
      return clonedInstance;
    }
    async write(taskPrompt, callOptions = {}) {
      if (typeof taskPrompt !== "string")
        throw new TypeError("Input 'taskPrompt' must be string.");
      let userPromptContent = `Writing Task:\n${taskPrompt}`;
      if (callOptions.context?.trim()) {
        userPromptContent += `\n\nContext:\n${callOptions.context.trim()}`;
      }
      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];
      return this._performApiRequest({ messages, callOptions });
    }
    writeStreaming(taskPrompt, callOptions = {}) {
      if (typeof taskPrompt !== "string")
        throw new TypeError("Input 'taskPrompt' must be string.");
      let userPromptContent = `Writing Task:\n${taskPrompt}`;
      if (callOptions.context?.trim()) {
        userPromptContent += `\n\nContext:\n${callOptions.context.trim()}`;
      }
      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: userPromptContent },
      ];
      // Writer spec implies streaming the full accumulated text
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: true,
      });
    }
  }

  class RewriterInstance extends BaseApiInstance {
    constructor(apiKey, options = {}) {
      // Rewriter spec options: sharedContext (at creation), instructions (at call time)
      super("rewriter", apiKey, Config.DEFAULT_REWRITER_MODEL, options);
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._creationSignal?.reason ??
          new DOMException("rewriter creation aborted.", "AbortError", {
            cause: this._creationSignal?.reason,
          })
        );
      }
    }

    /**
     * Creates a clone of this rewriter instance with the same configuration.
     * @returns {RewriterInstance} A new instance with the same configuration
     */
    clone() {
      // For RewriterInstance, the base clone is sufficient as there's no additional state to copy
      const clonedInstance = super.clone();
      Logger.log(`${this._apiName}: Cloned instance with same configuration`);
      return clonedInstance;
    }
    _buildSystemPrompt(
      instructions,
      sharedCtx,
      tone = "neutral",
      length = "medium",
    ) {
      const sharedContextSection = Utils.formatSharedContext(sharedCtx);
      let instructionsSection = "";
      if (instructions?.trim()) {
        instructionsSection = `Instructions:\n${instructions.trim()}`;
      } else {
        Logger.warn(`rewriter: Missing instructions for system prompt.`);
        instructionsSection = "Instructions: Rewrite the text.";
      }
      // Tone/length aren't formal rewrite params but add to prompt for guidance
      return Config.REWRITER_SYSTEM_PROMPT.replace(
        "{instructionsSection}",
        instructionsSection,
      )
        .replace("{sharedContextSection}", sharedContextSection)
        .replace("{tone}", tone)
        .replace("{length}", length);
    }
    async rewrite(text, callOptions) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be string.");
      if (
        !callOptions ||
        typeof callOptions.instructions !== "string" ||
        !callOptions.instructions.trim()
      ) {
        throw new TypeError(
          "Rewriter requires 'instructions' string in options.",
        );
      }
      // Note: Rewriter call options don't include tone/length per spec, using defaults for prompt guidance
      const systemPrompt = this._buildSystemPrompt(
        callOptions.instructions,
        this._options.sharedContext,
      );
      let userPromptContent = `Original Text:\n\`\`\`\n${text}\n\`\`\``;
      if (callOptions.context?.trim()) {
        userPromptContent += `\n\nContext:\n${callOptions.context.trim()}`;
      }
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPromptContent },
      ];
      return this._performApiRequest({ messages, callOptions });
    }
    rewriteStreaming(text, callOptions) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be string.");
      if (
        !callOptions ||
        typeof callOptions.instructions !== "string" ||
        !callOptions.instructions.trim()
      ) {
        throw new TypeError(
          "Rewriter requires 'instructions' string in options.",
        );
      }
      const systemPrompt = this._buildSystemPrompt(
        callOptions.instructions,
        this._options.sharedContext,
      );
      let userPromptContent = `Original Text:\n\`\`\`\n${text}\n\`\`\``;
      if (callOptions.context?.trim()) {
        userPromptContent += `\n\nContext:\n${callOptions.context.trim()}`;
      }
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPromptContent },
      ];
      // Rewriter spec implies streaming the full accumulated text
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: true,
      });
    }
  }

  class TranslatorInstance extends BaseApiInstance {
    _sourceLanguage;
    _targetLanguage;
    _systemPrompt;
    constructor(apiKey, options = {}) {
      if (
        typeof options.sourceLanguage !== "string" ||
        !options.sourceLanguage
      ) {
        throw new TypeError(`Missing/invalid 'sourceLanguage'.`);
      }
      if (
        typeof options.targetLanguage !== "string" ||
        !options.targetLanguage
      ) {
        throw new TypeError(`Missing/invalid 'targetLanguage'.`);
      }
      super("Translator", apiKey, Config.DEFAULT_TRANSLATOR_MODEL, options); // Use 'Translator' for logging clarity
      this._sourceLanguage = options.sourceLanguage;
      this._targetLanguage = options.targetLanguage;
      const sourceLanguageLong = Utils.languageTagToHumanReadable(
        this._sourceLanguage,
        this._targetLanguage,
      );
      const targetLanguageLong = Utils.languageTagToHumanReadable(
        this._targetLanguage,
        this._targetLanguage,
      );

      this._systemPrompt = Config.TRANSLATOR_SYSTEM_PROMPT.replace(
        "{sourceLanguage}",
        this._sourceLanguage,
      )
        .replace("{targetLanguage}", this._targetLanguage)
        .replace("{sourceLanguageLong}", sourceLanguageLong)
        .replace("{targetLanguageLong}", targetLanguageLong);
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._creationSignal?.reason ??
          new DOMException("Translator creation aborted.", "AbortError", {
            cause: this._creationSignal?.reason,
          })
        );
      }
    }

    /**
     * Creates a clone of this translator instance with the same configuration.
     * @returns {TranslatorInstance} A new instance with the same configuration
     */
    clone() {
      // Create a new instance with the same options
      const clonedInstance = super.clone();

      // Copy specific properties
      clonedInstance._sourceLanguage = this._sourceLanguage;
      clonedInstance._targetLanguage = this._targetLanguage;
      clonedInstance._systemPrompt = this._systemPrompt;

      Logger.log(
        `${this._apiName}: Cloned instance with source=${this._sourceLanguage}, target=${this._targetLanguage}`,
      );
      return clonedInstance;
    }
    async translate(text, callOptions = {}) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be string.");
      if (callOptions.context)
        Logger.warn(`${this._apiName}.translate: 'context' option is ignored.`);
      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: text },
      ];
      return this._performApiRequest({ messages, callOptions });
    }
    translateStreaming(text, callOptions = {}) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be string.");
      if (callOptions.context)
        Logger.warn(
          `${this._apiName}.translateStreaming: 'context' option is ignored.`,
        );
      const messages = [
        { role: "system", content: this._systemPrompt },
        { role: "user", content: text },
      ];
      // Translator streams raw text deltas
      return this._performApiStreamingRequest({
        messages,
        callOptions,
        accumulated: false,
      });
    }
  }

  class LanguageDetectorInstance extends BaseApiInstance {
    _expectedInputLanguages;
    constructor(apiKey, options = {}) {
      super(
        "LanguageDetector",
        apiKey,
        Config.DEFAULT_LANGUAGE_DETECTOR_MODEL,
        options,
      ); // Use 'LanguageDetector' for logging clarity
      this._expectedInputLanguages = options.expectedInputLanguages;
      if (this._expectedInputLanguages) {
        Logger.warn(
          `${this._apiName}: 'expectedInputLanguages' option noted but not actively used by AI model in emulation.`,
        );
      }
      if (this._combinedSignal.aborted) {
        this.destroy();
        throw (
          this._creationSignal?.reason ??
          new DOMException("LanguageDetector creation aborted.", "AbortError", {
            cause: this._creationSignal?.reason,
          })
        );
      }
    }

    /**
     * Creates a clone of this language detector instance with the same configuration.
     * @returns {LanguageDetectorInstance} A new instance with the same configuration
     */
    clone() {
      // Create a new instance with the same options
      const clonedInstance = super.clone();

      // Copy expected input languages
      clonedInstance._expectedInputLanguages = this._expectedInputLanguages
        ? [...this._expectedInputLanguages]
        : undefined;

      Logger.log(
        `${this._apiName}: Cloned instance with ${
          this._expectedInputLanguages
            ? `${this._expectedInputLanguages.length} expected languages`
            : "no expected languages"
        }`,
      );
      return clonedInstance;
    }
    async detect(text, callOptions = {}) {
      if (typeof text !== "string")
        throw new TypeError("Input 'text' must be string.");
      if (callOptions.context)
        Logger.warn(`${this._apiName}.detect: 'context' option is ignored.`);
      const messages = [
        { role: "system", content: Config.LANGUAGE_DETECTOR_SYSTEM_PROMPT },
        { role: "user", content: text },
      ];
      const responseJsonString = await this._performApiRequest({
        messages,
        callOptions,
      });
      let results = [{ detectedLanguage: "und", confidence: 1.0 }];
      try {
        const cleanedJsonString = responseJsonString
          .trim()
          .replace(/^```json\s*|\s*```$/g, "");
        const parsed = JSON.parse(cleanedJsonString);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              typeof item.detectedLanguage === "string" &&
              item.detectedLanguage &&
              typeof item.confidence === "number" &&
              item.confidence >= 0 &&
              item.confidence <= 1,
          )
        ) {
          results = parsed.sort((a, b) => b.confidence - a.confidence);

          results = Utils.normalizeConfidences(results);
        } else {
          Logger.warn(
            `${this._apiName}: Model response not valid JSON array of results. Using fallback. Response:`,
            responseJsonString,
          );
        }
      } catch (parseError) {
        Logger.warn(
          `${this._apiName}: Failed to parse model JSON response. Using fallback. Error:`,
          parseError,
          "Response:",
          responseJsonString,
        );
      }
      return results;
    }
  }

  // --- Placeholder Setup ---
  function setupPlaceholders() {
    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;

    if (!nsTarget[nsName]) {
      nsTarget[nsName] = {};
      Logger.log(`Created global namespace '${nsName}'`);
    }
    const aiNamespace = nsTarget[nsName];
    nsTarget[Config.PENDING_PROMISES_KEY] =
      nsTarget[Config.PENDING_PROMISES_KEY] || {}; // Ensure pending promises object exists

    const createPlaceholder = (apiName, isStatic = false) => {
      const placeholder = {
        availability: async () =>
          (await KeyManager.ensureApiKeyLoaded())
            ? isStatic
              ? "available"
              : "downloadable"
            : "unavailable",
        capabilities: async () => ({
          available: (await KeyManager.ensureApiKeyLoaded()) ? "readily" : "no",
        }),
        create: async (options = {}) => {
          if (!(await KeyManager.ensureApiKeyLoaded())) {
            throw new APIError(
              `${apiName}: Cannot create, API Key not configured.`,
            );
          }
          return new Promise((resolve, reject) => {
            // Store resolver/rejecter for the real `create` to use later
            nsTarget[Config.PENDING_PROMISES_KEY][apiName] = {
              resolve,
              reject,
              options,
            };
          });
        },
      };
      return placeholder;
    };

    const apisToCreate = [
      {
        name: "languageModel",
        lower: "languageModel",
        isStatic: false,
        enabled: Config.ENABLE_PROMPT_API,
      },
      {
        name: "summarizer",
        lower: "summarizer",
        isStatic: false,
        enabled: Config.ENABLE_SUMMARIZER_API,
      },
      {
        name: "writer",
        lower: "writer",
        isStatic: false,
        enabled: Config.ENABLE_WRITER_API,
      },
      {
        name: "rewriter",
        lower: "rewriter",
        isStatic: false,
        enabled: Config.ENABLE_REWRITER_API,
      },
      {
        name: "Translator",
        lower: "translator",
        isStatic: true,
        enabled: Config.ENABLE_TRANSLATOR_API,
      }, // Handle both cases
      {
        name: "LanguageDetector",
        lower: "languageDetector",
        isStatic: true,
        enabled: Config.ENABLE_LANGUAGE_DETECTOR_API,
      }, // Handle both cases
    ];

    apisToCreate.forEach(({ name, lower, isStatic, enabled }) => {
      if (enabled) {
        // Ensure placeholder exists for the primary name (potentially uppercase)
        if (!aiNamespace[name]) {
          aiNamespace[name] = createPlaceholder(name, isStatic);
        }
        // Ensure placeholder exists for the lowercase name if different
        if (name !== lower && !aiNamespace[lower]) {
          aiNamespace[lower] = createPlaceholder(lower, isStatic); // Use lowercase name for tracking promises
        }
      }
    });

    Logger.log(`Placeholders ensured.`);
  }

  // --- Main Initialization ---
  async function initializeApis() {
    await KeyManager.ensureApiKeyLoaded();
    GM_registerMenuCommand(
      "Set OpenRouter API Key",
      KeyManager.promptForApiKey,
    );
    GM_registerMenuCommand("Clear OpenRouter API Key", KeyManager.clearApiKey);
    GM_registerMenuCommand(
      "Check OpenRouter Key Status",
      KeyManager.showKeyStatus,
    );

    const nsTarget = Config.NAMESPACE_TARGET;
    const nsName = Config.EMULATED_NAMESPACE;
    const aiNamespace = nsTarget[nsName];
    const pendingPromises = nsTarget[Config.PENDING_PROMISES_KEY] || {};

    const createApiStatic = (apiName, InstanceClass, isEnabled) => {
      if (!isEnabled) return null;
      return {
        availability: async (options = {}) =>
          (await KeyManager.ensureApiKeyLoaded()) ? "available" : "unavailable", // Simplified
        capabilities: async () => ({
          available: (await KeyManager.ensureApiKeyLoaded()) ? "readily" : "no",
          defaultTemperature: Config.DEFAULT_TEMPERATURE,
          defaultTopK: Config.DEFAULT_TOP_K,
          maxTemperature: Config.MAX_TEMPERATURE,
          maxTopK: Config.MAX_TOP_K,
        }),
        create: async (options = {}) => {
          const key = await KeyManager.ensureApiKeyLoaded();
          // Use apiName (which could be upper or lower) to find pending promise
          const pending = pendingPromises[apiName];
          if (!key) {
            const error = new APIError(
              `${apiName}: Cannot create, API Key not configured.`,
            );
            pending?.reject?.(error);
            if (pending) delete pendingPromises[apiName];
            throw error;
          }
          try {
            const instance = new InstanceClass(key, options);
            pending?.resolve?.(instance);
            return instance;
          } catch (error) {
            Logger.error(`${apiName}: Error during instance creation:`, error);
            pending?.reject?.(error);
            throw error; // Rethrow creation error
          } finally {
            if (pending && pendingPromises[apiName])
              delete pendingPromises[apiName]; // Clean up processed promise
          }
        },
      };
    };

    const createTranslatorApi = (apiName, InstanceClass, isEnabled) => {
      if (!isEnabled) return null;
      const baseApi = createApiStatic(apiName, InstanceClass, isEnabled);

      if (baseApi) {
        // Add translator-specific capabilities
        const originalCapabilities = baseApi.capabilities;
        baseApi.capabilities = async () => {
          const baseCapabilities = await originalCapabilities();
          return {
            ...baseCapabilities,
            languagePairAvailable: baseApi.languagePairAvailable,
          };
        };

        // Add languagePairAvailable function
        baseApi.languagePairAvailable = async (options = {}) => {
          if (!options?.sourceLanguage || !options?.targetLanguage) {
            return "unavailable";
          }
          return (await KeyManager.ensureApiKeyLoaded())
            ? "available"
            : "unavailable";
        };
      }

      return baseApi;
    };

    const apiDefinitions = [
      {
        name: "languageModel",
        lower: "languageModel",
        InstanceClass: LanguageModelSession,
        enabled: Config.ENABLE_PROMPT_API,
        apiCreator: createApiStatic,
      },
      {
        name: "summarizer",
        lower: "summarizer",
        InstanceClass: SummarizerInstance,
        enabled: Config.ENABLE_SUMMARIZER_API,
        apiCreator: createApiStatic,
      },
      {
        name: "writer",
        lower: "writer",
        InstanceClass: WriterInstance,
        enabled: Config.ENABLE_WRITER_API,
        apiCreator: createApiStatic,
      },
      {
        name: "rewriter",
        lower: "rewriter",
        InstanceClass: RewriterInstance,
        enabled: Config.ENABLE_REWRITER_API,
        apiCreator: createApiStatic,
      },
      {
        name: "Translator",
        lower: "translator",
        InstanceClass: TranslatorInstance,
        enabled: Config.ENABLE_TRANSLATOR_API,
        apiCreator: createTranslatorApi,
      },
      {
        name: "LanguageDetector",
        lower: "languageDetector",
        InstanceClass: LanguageDetectorInstance,
        enabled: Config.ENABLE_LANGUAGE_DETECTOR_API,
        apiCreator: createApiStatic,
      },
    ];

    apiDefinitions.forEach(
      ({ name, lower, InstanceClass, enabled, apiCreator }) => {
        const staticApi = apiCreator(name, InstanceClass, enabled); // Use primary name for static creator
        if (staticApi) {
          // Attach to primary name (e.g., ai.languageModel, ai.Translator)
          Object.assign(aiNamespace[name], staticApi);
          // If lowercase name is different, also attach to lowercase (e.g., ai.translator)
          // Create static methods specifically for the lowercase name as well
          if (name !== lower) {
            const staticApiLower = apiCreator(lower, InstanceClass, enabled);
            if (staticApiLower) {
              // Ensure the lowercase object exists before assigning
              if (!aiNamespace[lower]) aiNamespace[lower] = {};
              Object.assign(aiNamespace[lower], staticApiLower);
            }
          }
        }
      },
    );

    let logMessage = `Chrome AI API emulator initialized.`;
    const enabledApiNames = apiDefinitions
      .filter((api) => api.enabled)
      .map((api) => api.lower); // Use lowercase names for logging
    if (enabledApiNames.length > 0) {
      logMessage += ` Enabled APIs: [${enabledApiNames.join(", ")}].`;
      const accessPoint = Object.keys(nsTarget).includes(nsName)
        ? `window.${nsName}`
        : `unsafeWindow.${nsName}`;
      logMessage += ` Access via: ${accessPoint}`;
    } else {
      logMessage += ` No APIs enabled.`;
    }
    Logger.log(logMessage);

    if (!openRouterApiKey) {
      Logger.warn(
        `OpenRouter API Key is not set. Use Tampermonkey menu. APIs will fail.`,
      );
      Object.entries(pendingPromises).forEach(([apiName, { reject }]) => {
        if (reject) reject(new APIError(`${apiName}: API key not configured.`));
      });
    } else {
      Logger.log(`OpenRouter API Key loaded.`);
    }

    if (nsTarget[Config.PENDING_PROMISES_KEY]) {
      Object.values(nsTarget[Config.PENDING_PROMISES_KEY]).forEach((p) => {
        p.resolve = null;
        p.reject = null;
      });
      delete nsTarget[Config.PENDING_PROMISES_KEY];
      Logger.log(`Cleaned up pending promise tracking.`);
    }
  }

  // --- Script Execution ---
  setupPlaceholders(); // Run immediately
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      initializeApis().catch(handleInitError),
    );
  } else {
    initializeApis().catch(handleInitError);
  }
  function handleInitError(error) {
    Logger.error(`Fatal error during initialization:`, error);
    alert(
      `Chrome AI Emulator: Failed to initialize. Check console. Error: ${error.message}`,
    );
  }
})();
