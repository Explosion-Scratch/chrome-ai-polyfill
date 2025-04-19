// ==UserScript==
// @name        Chrome Prompt API Emulator
// @namespace   mailto:explosionscratch@gmail.com
// @version     1.2
// @description Emulates the experimental Chrome Prompt API (chrome.aiOriginTrial.languageModel) and Summarizer API (ai.summarizer) using the OpenRouter API.
// @author      Explosion Implosion
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_registerMenuCommand
// @connect     openrouter.ai
// @run-at      document-start
// ==/UserScript==

// TODO: Don't ask for API key consistently
// TODO: Allow switching of openrouter endpoint better
// TODO: Consolidate logic for creating summarizer/language model

(async function () {
  "use strict";
  // --- Configuration Constants ---

  /**
   * @constant {string} DEFAULT_MODEL - Default model for general prompts.
   * @see https://openrouter.ai/docs#models for available models.
   */
  const DEFAULT_MODEL = "meta-llama/llama-4-scout:free"; // Example free model
  /**
   * @constant {string} DEFAULT_SUMMARIZER_MODEL - Default model specifically for summarization tasks. Can be the same as DEFAULT_MODEL.
   */
  const DEFAULT_SUMMARIZER_MODEL = DEFAULT_MODEL; // Or choose another model if desired
  /**
   * @constant {string} YOUR_SITE_URL - Your site URL for OpenRouter Referer header (recommended).
   */
  const YOUR_SITE_URL = window.location.origin;
  /**
   * @constant {string} YOUR_APP_NAME - Your application name for OpenRouter X-Title header (recommended).
   */
  const YOUR_APP_NAME = "ChromeAI_API_Emulator";
  /**
   * @constant {string} API_KEY_STORAGE_KEY - Key used to store the OpenRouter API key in GM storage.
   */
  const API_KEY_STORAGE_KEY = "openrouter_api_key";
  /**
   * @constant {Window} NAMESPACE_TARGET - Target namespace to attach the emulated API (unsafeWindow for global access).
   */
  const NAMESPACE_TARGET = unsafeWindow;
  /**
   * @constant {string} EMULATED_NAMESPACE - Name of the object to attach to NAMESPACE_TARGET.
   */
  const EMULATED_NAMESPACE = "ai";
  /**
   * @constant {string} SUMMARIZER_SYSTEM_PROMPT_TEMPLATE - Template for the summarizer's system prompt.
   * Placeholders: {type}, {format}, {length}, {sharedContext}
   */
  const SUMMARIZER_SYSTEM_PROMPT_TEMPLATE = `
You are an expert text summarizer. Your goal is to generate a concise and accurate summary based on the provided text and instructions.

Instructions for this summarization task:
- Summary Type: {type}
- Output Format: {format}
- Desired Length: {length}
{sharedContextSection}
Generate only the summary based on the user's text and context, adhering strictly to the specified type, format, and length. Do not add any conversational filler or explanations before or after the summary.
  `.trim();

  const tokenize = (t) => t.length / 5;

  // --- State Variables ---

  /** @type {string|null} */
  let openRouterApiKey = await GM_getValue(API_KEY_STORAGE_KEY, null);

  // --- API Key Management ---

  /**
   * Prompts the user to enter their OpenRouter API key.
   * Stores the key in Greasemonkey/Tampermonkey storage.
   * @async
   * @returns {Promise<string|null>} The API key if entered, otherwise null.
   */
  async function promptForApiKey() {
    const key = prompt(
      "Please enter your OpenRouter API Key (see https://openrouter.ai/keys):",
      openRouterApiKey || "",
    );
    if (key) {
      await GM_setValue(API_KEY_STORAGE_KEY, key);
      openRouterApiKey = key;
      alert(
        "API Key saved. Please reload the page for the APIs to become available.",
      );
      return key;
    }
    return null;
  }

  /**
   * Ensures that an OpenRouter API key is available.
   * Prompts the user for the key if it's not already stored.
   * @async
   * @returns {Promise<string|null>} The API key, or null if the user cancels the prompt.
   */
  async function ensureApiKey() {
    if (!openRouterApiKey) {
      console.warn(
        `${EMULATED_NAMESPACE}: OpenRouter API Key not found. Prompting user.`,
      );
      return await promptForApiKey();
    }
    return openRouterApiKey;
  }

  GM_registerMenuCommand("Set OpenRouter API Key", promptForApiKey);
  GM_registerMenuCommand("Clear OpenRouter API Key", async () => {
    await GM_deleteValue(API_KEY_STORAGE_KEY);
    openRouterApiKey = null;
    alert("API Key cleared. Please reload the page.");
  });

  // --- Core API Interaction Logic ---

  /**
   * Parses Server-Sent Events (SSE) data to extract content chunks.
   * @param {string} sseData - The raw SSE data string.
   * @returns {string[]} An array of content chunks extracted from the SSE data.
   */
  function parseSSE(sseData) {
    const lines = sseData.trim().split("\n");
    const chunks = [];
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataContent = line.substring(6).trim();
        if (dataContent === "[DONE]") {
          break;
        }
        try {
          const json = JSON.parse(dataContent);
          if (
            json.choices &&
            json.choices[0] &&
            json.choices[0].delta &&
            json.choices[0].delta.content
          ) {
            chunks.push(json.choices[0].delta.content);
          }
        } catch (e) {
          console.error(
            `${EMULATED_NAMESPACE}: Error parsing SSE chunk:`,
            dataContent,
            e,
          );
        }
      }
    }
    return chunks;
  }

  /**
   * Unified function to handle OpenRouter API requests with streaming and non-streaming modes.
   * @async
   * @param {object} params - Parameters for the API request.
   * @param {string} params.apiKey - The OpenRouter API key.
   * @param {AILanguageModelMessage[]} params.messages - The message history/prompt.
   * @param {string} [params.model] - The model to use. Defaults to DEFAULT_MODEL.
   * @param {object} [params.parameters] - Model parameters.
   * @param {number} [params.parameters.temperature] - Temperature for response generation.
   * @param {number} [params.parameters.topK] - Top-k parameter.
   * @param {boolean} [params.stream=false] - Whether to use streaming mode.
   * @param {AbortSignal} [params.signal] - Abort signal for the request.
   * @param {object} params.on - Event handlers for streaming/completion.
   * @param {function(string): void} [params.on.chunk] - Callback for each chunk delta in streaming mode. Parameter is delta.
   * @param {function(string): void} [params.on.finish] - Callback when the stream finishes or for non-streaming response. Parameter is full message.
   * @param {function(Error): void} [params.on.error] - Callback for errors. Parameter is error object.
   * @returns {Promise<string>} - Promise that resolves with the full response content.
   * @throws {Error} If OpenRouter API Key is not configured or API returns an error.
   * @throws {DOMException} If the operation is aborted.
   */
  async function askOpenRouter({
    apiKey,
    messages,
    model = DEFAULT_MODEL,
    parameters,
    stream = false,
    signal,
    on,
  }) {
    if (!apiKey) {
      const error = new Error(
        `${EMULATED_NAMESPACE}: OpenRouter API Key is not configured.`,
      );
      on.error?.(error);
      return Promise.reject(error);
    }

    if (signal?.aborted) {
      const error = new DOMException("Operation aborted.", "AbortError");
      on.error?.(error);
      return Promise.reject(error);
    }

    const requestBody = {
      model: model,
      messages: messages,
      stream: stream === true,
    };

    if (parameters) {
      if (parameters.temperature !== undefined)
        requestBody.temperature = parameters.temperature;
      if (parameters.topK !== undefined) requestBody.top_k = parameters.topK;
      // Note: Chrome Prompt API options might not map 1:1. Add more mappings if needed.
    }

    const controller = new AbortController();
    const actualSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    // Add listener to propagate abort reason if original signal aborts
    let abortReason = null;
    const abortHandler = (event) => {
      abortReason =
        event?.reason ?? new DOMException("Operation aborted.", "AbortError");
      controller.abort(abortReason); // Propagate abort to the fetch request
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    return new Promise(async (resolve, reject) => {
      let accumulatedResponse = "";

      const requestOptions = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": YOUR_SITE_URL,
          "X-Title": YOUR_APP_NAME,
        },
        body: JSON.stringify(requestBody),
        signal: actualSignal,
      };

      if (stream) {
        requestOptions.headers.Accept = "text/event-stream";
      }

      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          requestOptions,
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `${EMULATED_NAMESPACE}: API error ${response.status}:`,
            errorText,
          );
          const error = new Error(
            `${EMULATED_NAMESPACE}: OpenRouter API Error (${response.status}) - ${response.statusText}. Check console for details. Body: ${errorText.substring(0, 200)}`,
          );
          on.error?.(error);
          reject(error);
          return;
        }

        if (stream) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            if (actualSignal.aborted) {
              // Check before and after read()
              const error =
                abortReason ||
                new DOMException(
                  "Operation aborted during stream.",
                  "AbortError",
                );
              on.error?.(error);
              reject(error);
              reader.cancel(error); // Cancel the reader
              break;
            }

            const { done, value } = await reader.read();

            if (actualSignal.aborted) {
              const error =
                abortReason ||
                new DOMException(
                  "Operation aborted during stream.",
                  "AbortError",
                );
              on.error?.(error);
              reject(error);
              reader.cancel(error);
              break;
            }

            if (done) {
              on.finish?.(accumulatedResponse);
              resolve(accumulatedResponse);
              break;
            }

            const chunkText = decoder.decode(value, { stream: true }); // Use stream: true
            const chunks = parseSSE(chunkText);
            chunks.forEach((delta) => {
              if (delta) {
                accumulatedResponse += delta;
                on.chunk?.(delta); // Only pass the delta
              }
            });
          }
        } else {
          // Non-streaming
          const jsonResponse = await response.json();
          if (jsonResponse?.choices?.[0]?.message?.content) {
            const content = jsonResponse.choices[0].message.content;
            on.finish?.(content);
            resolve(content);
          } else {
            console.error(
              `${EMULATED_NAMESPACE}: Invalid non-streaming response structure:`,
              jsonResponse,
            );
            const error = new Error(
              `${EMULATED_NAMESPACE}: Invalid response structure from OpenRouter.`,
            );
            on.error?.(error);
            reject(error);
          }
        }
      } catch (error) {
        // Handle fetch errors (network, abort, etc.)
        let finalError;
        if (error.name === "AbortError" || actualSignal.aborted) {
          finalError =
            abortReason || new DOMException("Operation aborted.", "AbortError");
        } else {
          console.error(`${EMULATED_NAMESPACE}: Network/Fetch error:`, error);
          finalError = new Error(
            `${EMULATED_NAMESPACE}: Network error calling OpenRouter: ${error.message}`,
          );
        }
        on.error?.(finalError);
        reject(finalError);
      } finally {
        controller.abort(); // Clean up internal controller
        signal?.removeEventListener("abort", abortHandler); // Clean up listener
      }
    });
  }

  // --- Type Definitions ---

  /**
   * Represents a message in the conversation.
   * @typedef {object} AILanguageModelMessage
   * @property {'user' | 'assistant' | 'system'} role - The role of the message sender.
   * @property {string} content - The message content.
   */

  /**
   * Options for creating a language model session (Prompt API).
   * @typedef {object} AILanguageModelCreateOptions
   * @property {string} [systemPrompt] - Sets the assistant's behavior.
   * @property {AILanguageModelMessage[]} [initialPrompts] - Conversation history.
   * @property {number} [temperature] - Controls randomness (0-1).
   * @property {number} [topK] - Limits token consideration (integer). Maps to OpenRouter's top_k.
   * @property {AbortSignal} [signal] - Allows session abortion.
   */

  /**
   * Options for creating a summarizer instance (Summarizer API).
   * @typedef {object} AISummarizerCreateOptions
   * @property {string} [sharedContext] - Additional context for all summaries.
   * @property {'key-points' | 'tl;dr' | 'teaser' | 'headline'} [type='key-points'] - Type of summary.
   * @property {'markdown' | 'plain-text'} [format='markdown'] - Output format.
   * @property {'short' | 'medium' | 'long'} [length='medium'] - Desired summary length.
   * @property {AbortSignal} [signal] - Allows creation abortion.
   * @property {function({ addEventListener: function(string, function) })} [monitor] - For download progress (ignored in emulation).
   * @property {string[]} [expectedInputLanguages] - Ignored in emulation.
   * @property {string[]} [expectedContextLanguages] - Ignored in emulation.
   * @property {string} [outputLanguage] - Ignored in emulation.
   */

  /**
   * Represents an active session with the language model (Prompt API).
   * @typedef {object} LanguageModelSession
   * @property {function(string): Promise<string>} prompt - Generates a non-streaming response.
   * @property {function(string): ReadableStream<string>} promptStreaming - Generates a streaming response.
   * @property {function(): void} destroy - Cleans up the session.
   * @property {AbortController} _abortController - Internal abort controller for the session.
   * @property {AILanguageModelMessage[]} _history - Internal conversation history.
   * @property {AILanguageModelCreateOptions} _options - Internal session options.
   */

  /**
   * Represents an active summarizer instance (Summarizer API).
   * @typedef {object} SummarizerInstance
   * @property {function(string, {context?: string, signal?: AbortSignal}=): Promise<string>} summarize - Generates a non-streaming summary.
   * @property {function(string, {context?: string, signal?: AbortSignal}=): ReadableStream<string>} summarizeStreaming - Generates a streaming summary.
   * @property {function(): void} destroy - Cleans up the instance.
   * @property {AbortController} _abortController - Internal abort controller for the instance.
   * @property {string} _systemPrompt - The system prompt constructed from options.
   * @property {AISummarizerCreateOptions} _options - Internal instance options.
   * @property {number} inputQuota - Dummy value for compatibility.
   * @property {function(string): Promise<number>} measureInputUsage - Dummy function for compatibility.
   */

  // --- Prompt API Implementation ---

  /**
   * Creates a new language model session (Prompt API emulation).
   * @async
   * @param {string} apiKey - OpenRouter API key.
   * @param {AILanguageModelCreateOptions} [options={}] - Session configuration.
   * @returns {Promise<LanguageModelSession>}
   * @throws {Error} If API key is missing.
   * @throws {DOMException} If session creation is aborted.
   * @throws {TypeError} If initialPrompts format is invalid.
   */
  async function createPromptSession(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error(
        `${EMULATED_NAMESPACE}.languageModel: Cannot create session, OpenRouter API Key is not configured.`,
      );
    }

    const sessionAbortController = new AbortController();
    // Combine external signal with internal session controller
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, sessionAbortController.signal])
      : sessionAbortController.signal;

    // Early exit if already aborted
    if (combinedSignal.aborted) {
      throw (
        options.signal?.reason ??
        new DOMException("Session creation aborted.", "AbortError")
      );
    }

    // Listen for external abort signal after creation starts
    let creationAbortReason = null;
    const externalAbortHandler = (event) => {
      creationAbortReason =
        event?.reason ??
        new DOMException("Session creation aborted externally.", "AbortError");
      console.log(
        `${EMULATED_NAMESPACE}.languageModel: Session creation aborted externally.`,
      );
      sessionAbortController.abort(creationAbortReason); // Trigger internal abort
    };
    options.signal?.addEventListener("abort", externalAbortHandler, {
      once: true,
    });

    const history = [];
    if (options.systemPrompt) {
      history.push({ role: "system", content: options.systemPrompt });
    }
    if (options.initialPrompts) {
      if (
        !Array.isArray(options.initialPrompts) ||
        options.initialPrompts.some(
          (p) => typeof p !== "object" || !p.role || !p.content,
        )
      ) {
        const error = new TypeError(
          `${EMULATED_NAMESPACE}.languageModel: Invalid initialPrompts format.`,
        );
        options.signal?.removeEventListener("abort", externalAbortHandler);
        sessionAbortController.abort(error); // Abort if invalid options
        throw error;
      }
      // Ensure system prompt (if any) is first and unique
      const systemPrompts = options.initialPrompts.filter(
        (p) => p.role === "system",
      );
      if (options.systemPrompt && systemPrompts.length > 0) {
        const error = new TypeError(
          `${EMULATED_NAMESPACE}.languageModel: Cannot provide both systemPrompt option and a system role in initialPrompts.`,
        );
        options.signal?.removeEventListener("abort", externalAbortHandler);
        sessionAbortController.abort(error);
        throw error;
      }
      if (systemPrompts.length > 1) {
        const error = new TypeError(
          `${EMULATED_NAMESPACE}.languageModel: Only one system role message is allowed in initialPrompts.`,
        );
        options.signal?.removeEventListener("abort", externalAbortHandler);
        sessionAbortController.abort(error);
        throw error;
      }
      if (
        systemPrompts.length === 1 &&
        options.initialPrompts[0].role !== "system"
      ) {
        const error = new TypeError(
          `${EMULATED_NAMESPACE}.languageModel: System role message must be the first in initialPrompts.`,
        );
        options.signal?.removeEventListener("abort", externalAbortHandler);
        sessionAbortController.abort(error);
        throw error;
      }
      history.push(...options.initialPrompts);
    }

    // --- Session Object ---
    const session = {
      _history: history,
      _options: {
        // Store relevant options for askOpenRouter
        temperature: options.temperature,
        topK: options.topK,
      },
      _abortController: sessionAbortController,

      /**
       * Generates a non-streaming response (Prompt API).
       * Updates the session history.
       */
      prompt: async function (text) {
        if (typeof text !== "string")
          throw new TypeError("Input 'text' must be a string.");
        if (combinedSignal.aborted)
          throw (
            sessionAbortController.signal.reason ??
            new DOMException("Operation aborted.", "AbortError")
          );

        const currentUserMessage = { role: "user", content: text };
        const currentHistory = [...this._history, currentUserMessage]; // History for this call

        try {
          const assistantResponse = await askOpenRouter({
            apiKey: apiKey,
            messages: currentHistory,
            parameters: this._options,
            model: DEFAULT_MODEL, // Or allow model selection via options?
            stream: false, // Non-streaming
            signal: combinedSignal, // Use combined signal
            on: {
              finish: (fullMessage) => {
                // Update history ONLY on successful completion
                this._history.push(currentUserMessage);
                this._history.push({
                  role: "assistant",
                  content: fullMessage,
                });
                console.log(
                  `${EMULATED_NAMESPACE}.languageModel: prompt finished. History updated.`,
                );
              },
              error: (err) => {
                console.error(
                  `${EMULATED_NAMESPACE}.languageModel: prompt Error:`,
                  err,
                );
                // Don't update history on error
              },
            },
          });
          return assistantResponse;
        } catch (error) {
          // Rethrow error (already logged by askOpenRouter's on.error)
          // Ensure it's the correct abort reason if applicable
          if (error.name === "AbortError" || combinedSignal.aborted) {
            throw sessionAbortController.signal.reason ?? error;
          }
          throw error;
        }
      },

      /**
       * Generates a streaming response (Prompt API).
       * Updates the session history *after* the stream completes successfully.
       */
      promptStreaming: function (text) {
        if (typeof text !== "string")
          throw new TypeError("Input 'text' must be a string.");

        // Check abort status *before* creating the stream
        if (combinedSignal.aborted) {
          const abortError =
            sessionAbortController.signal.reason ??
            new DOMException("Operation aborted.", "AbortError");
          return new ReadableStream({
            start(controller) {
              controller.error(abortError);
            },
          });
        }

        const currentUserMessage = { role: "user", content: text };
        const currentHistory = [...this._history, currentUserMessage]; // History for this call

        let streamController;
        let accumulatedResponse = "";
        let requestAborted = false; // Flag to prevent actions after abort/error

        const stream = new ReadableStream({
          start: (controller) => {
            streamController = controller;

            askOpenRouter({
              apiKey: apiKey,
              messages: currentHistory,
              parameters: this._options,
              model: DEFAULT_MODEL,
              stream: true,
              signal: combinedSignal, // Pass the combined signal
              on: {
                chunk: (delta) => {
                  if (requestAborted) return;
                  try {
                    // Note: The Prompt API spec returns strings, not Uint8Array
                    // We are returning strings directly from askOpenRouter parsing.
                    streamController.enqueue(delta);
                    accumulatedResponse += delta;
                  } catch (e) {
                    console.error(
                      `${EMULATED_NAMESPACE}.languageModel: Error enqueuing chunk:`,
                      e,
                    );
                    requestAborted = true;
                    // We might not be able to error the controller if it's already closed/errored
                    try {
                      streamController.error(e);
                    } catch (_) {}
                  }
                },
                finish: (fullMessage) => {
                  if (requestAborted) return;
                  // Update history ONLY on successful completion
                  this._history.push(currentUserMessage);
                  this._history.push({
                    role: "assistant",
                    content: fullMessage,
                  }); // Use final message
                  console.log(
                    `${EMULATED_NAMESPACE}.languageModel: promptStreaming finished. History updated.`,
                  );
                  try {
                    streamController.close();
                  } catch (_) {} // Might already be closed
                },
                error: (error) => {
                  if (requestAborted) return;
                  requestAborted = true;
                  console.error(
                    `${EMULATED_NAMESPACE}.languageModel: promptStreaming Error:`,
                    error,
                  );
                  // Don't update history on error
                  try {
                    // Pass the original error (could be AbortError with reason)
                    streamController.error(error);
                  } catch (_) {} // Might already be errored
                },
              },
            }).catch((error) => {
              // Catch errors from askOpenRouter promise itself (e.g., initial setup errors)
              if (!requestAborted) {
                requestAborted = true;
                console.error(
                  `${EMULATED_NAMESPACE}.languageModel: promptStreaming askOpenRouter catch:`,
                  error,
                );
                try {
                  streamController.error(error);
                } catch (_) {}
              }
            });
          },
          cancel: (reason) => {
            console.log(
              `${EMULATED_NAMESPACE}.languageModel: Stream cancelled. Reason:`,
              reason,
            );
            requestAborted = true; // Prevent further actions
            // We don't directly control the fetch abort here,
            // it should be handled by the signal passed to askOpenRouter.
            // If cancellation originates from the stream consumer without an AbortSignal,
            // the fetch might continue, but we stop processing chunks/finish.
          },
        });

        return stream;
      },

      /** Destroys the session, aborting ongoing requests */
      destroy: function () {
        console.log(
          `${EMULATED_NAMESPACE}.languageModel: Session destroy called.`,
        );
        // Abort with a specific reason if not already aborted
        if (!this._abortController.signal.aborted) {
          this._abortController.abort(
            new DOMException("Session destroyed.", "AbortError"),
          );
        }
        options.signal?.removeEventListener("abort", externalAbortHandler); // Clean up listener
      },
    };

    // Final check for immediate abort after setup but before returning
    if (combinedSignal.aborted) {
      console.log(
        `${EMULATED_NAMESPACE}.languageModel: Session aborted immediately after setup.`,
      );
      session.destroy(); // Ensure cleanup
      throw (
        sessionAbortController.signal.reason ??
        new DOMException("Session creation aborted.", "AbortError")
      );
    }

    // Clean up listener if creation succeeds
    options.signal?.removeEventListener("abort", externalAbortHandler);

    return session;
  }

  /** Creates the `languageModel` API object */
  function createLanguageModelApiObject() {
    const languageModelApi = {
      /** Check model availability (depends on API key) */
      capabilities: async function () {
        const key = await ensureApiKey();
        // Simplification: 'after-download' isn't relevant for API-based emulation.
        return { available: key ? "readily" : "no" };
      },

      /** Create a new session */
      create: async function (options = {}) {
        const key = await ensureApiKey(); // Ensure key exists before creating
        if (!key) {
          throw new Error(
            `${EMULATED_NAMESPACE}.languageModel: Cannot create session, OpenRouter API Key is not configured.`,
          );
        }
        return createPromptSession(key, options);
      },
      // Note: The explainer mentions LanguageModel.params() but it's not in the Chrome 131 API reference.
      // Omitting it for now based on the reference.
    };
    return languageModelApi;
  }

  // --- Summarizer API Implementation ---

  /**
   * Creates a new summarizer instance (Summarizer API emulation).
   * @async
   * @param {string} apiKey - OpenRouter API key.
   * @param {AISummarizerCreateOptions} [options={}] - Instance configuration.
   * @returns {Promise<SummarizerInstance>}
   * @throws {Error} If API key is missing.
   * @throws {DOMException} If instance creation is aborted.
   */
  async function createSummarizerInstance(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error(
        `${EMULATED_NAMESPACE}.summarizer: Cannot create instance, OpenRouter API Key is not configured.`,
      );
    }

    const instanceAbortController = new AbortController();
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, instanceAbortController.signal])
      : instanceAbortController.signal;

    if (combinedSignal.aborted) {
      throw (
        options.signal?.reason ??
        new DOMException("Summarizer creation aborted.", "AbortError")
      );
    }

    // Listen for external abort during creation
    let creationAbortReason = null;
    const externalAbortHandler = (event) => {
      creationAbortReason =
        event?.reason ??
        new DOMException(
          "Summarizer creation aborted externally.",
          "AbortError",
        );
      console.log(
        `${EMULATED_NAMESPACE}.summarizer: Creation aborted externally.`,
      );
      instanceAbortController.abort(creationAbortReason);
    };
    options.signal?.addEventListener("abort", externalAbortHandler, {
      once: true,
    });

    // --- Process Options & Build System Prompt ---
    const type = options.type ?? "key-points";
    const format = options.format ?? "markdown";
    const length = options.length ?? "medium";
    const sharedContext = options.sharedContext ?? "";

    let sharedContextSection = "";
    if (sharedContext.trim()) {
      sharedContextSection = `\n\nShared Context:\n${sharedContext.trim()}`;
    }

    const systemPrompt = SUMMARIZER_SYSTEM_PROMPT_TEMPLATE.replaceAll(
      "{type}",
      type,
    )
      .replaceAll("{format}", format)
      .replaceAll("{length}", length)
      .replaceAll("{sharedContextSection}", sharedContextSection);

    // --- Summarizer Instance Object ---
    const summarizerInstance = {
      _options: options, // Keep original options if needed later
      _systemPrompt: systemPrompt,
      _abortController: instanceAbortController,
      inputQuota: Infinity, // Emulation doesn't enforce quota

      measureInputUsage: tokenize,

      /** Generate non-streaming summary */
      summarize: async function (text, callOptions = {}) {
        if (typeof text !== "string")
          throw new TypeError("Input 'text' must be a string.");
        const signal = callOptions.signal
          ? AbortSignal.any([combinedSignal, callOptions.signal])
          : combinedSignal;

        if (signal.aborted) {
          throw (
            signal.reason ??
            new DOMException("Summarization aborted.", "AbortError")
          );
        }

        let userPromptContent = `Summarize the following text:\n\n\`\`\`\n${text}\n\`\`\``;
        if (callOptions.context?.trim()) {
          userPromptContent += `\n\nAdditional Context (for this summary only):\n${callOptions.context.trim()}`;
        }

        const messages = [
          { role: "system", content: this._systemPrompt },
          { role: "user", content: userPromptContent },
        ];

        try {
          const summary = await askOpenRouter({
            apiKey: apiKey,
            messages: messages,
            model: DEFAULT_SUMMARIZER_MODEL, // Use dedicated summarizer model
            parameters: {}, // No specific temp/topK for summarizer API
            stream: false,
            signal: signal, // Pass combined signal for this specific call
            on: {
              finish: (msg) =>
                console.log(
                  `${EMULATED_NAMESPACE}.summarizer: summarize finished.`,
                ),
              error: (err) =>
                console.error(
                  `${EMULATED_NAMESPACE}.summarizer: summarize Error:`,
                  err,
                ),
            },
          });
          return summary;
        } catch (error) {
          // Rethrow error, ensuring correct abort reason
          if (error.name === "AbortError" || signal.aborted) {
            throw signal.reason ?? error;
          }
          throw error;
        }
      },

      /** Generate streaming summary */
      summarizeStreaming: function (text, callOptions = {}) {
        if (typeof text !== "string")
          throw new TypeError("Input 'text' must be a string.");
        const signal = callOptions.signal
          ? AbortSignal.any([combinedSignal, callOptions.signal])
          : combinedSignal;

        if (signal.aborted) {
          const abortError =
            signal.reason ??
            new DOMException("Summarization aborted.", "AbortError");
          return new ReadableStream({
            start(controller) {
              controller.error(abortError);
            },
          });
        }

        let userPromptContent = `Summarize the following text:\n\n\`\`\`\n${text}\n\`\`\``;
        if (callOptions.context?.trim()) {
          userPromptContent += `\n\nAdditional Context (for this summary only):\n${callOptions.context.trim()}`;
        }

        const messages = [
          { role: "system", content: this._systemPrompt },
          { role: "user", content: userPromptContent },
        ];

        let streamController;
        let requestAborted = false;

        const stream = new ReadableStream({
          start: (controller) => {
            streamController = controller;
            askOpenRouter({
              apiKey: apiKey,
              messages: messages,
              model: DEFAULT_SUMMARIZER_MODEL,
              parameters: {},
              stream: true,
              signal: signal, // Use the combined signal for this call
              on: {
                chunk: (delta) => {
                  if (requestAborted) return;
                  try {
                    streamController.enqueue(delta);
                  } catch (e) {
                    console.error("Error enqueuing:", e);
                    requestAborted = true;
                    try {
                      streamController.error(e);
                    } catch (_) {}
                  }
                },
                finish: (fullMsg) => {
                  if (requestAborted) return;
                  console.log(
                    `${EMULATED_NAMESPACE}.summarizer: summarizeStreaming finished.`,
                  );
                  try {
                    streamController.close();
                  } catch (_) {}
                },
                error: (error) => {
                  if (requestAborted) return;
                  requestAborted = true;
                  console.error(
                    `${EMULATED_NAMESPACE}.summarizer: summarizeStreaming Error:`,
                    error,
                  );
                  try {
                    streamController.error(error);
                  } catch (_) {}
                },
              },
            }).catch((error) => {
              if (!requestAborted) {
                requestAborted = true;
                console.error(
                  `${EMULATED_NAMESPACE}.summarizer: summarizeStreaming askOpenRouter catch:`,
                  error,
                );
                try {
                  streamController.error(error);
                } catch (_) {}
              }
            });
          },
          cancel: (reason) => {
            console.log(
              `${EMULATED_NAMESPACE}.summarizer: Stream cancelled. Reason:`,
              reason,
            );
            requestAborted = true;
            // Abort signal passed to askOpenRouter should handle fetch cancellation
          },
        });
        return stream;
      },

      /** Destroy the summarizer instance */
      destroy: function () {
        console.log(
          `${EMULATED_NAMESPACE}.summarizer: Instance destroy called.`,
        );
        if (!this._abortController.signal.aborted) {
          this._abortController.abort(
            new DOMException("Summarizer instance destroyed.", "AbortError"),
          );
        }
        options.signal?.removeEventListener("abort", externalAbortHandler); // Clean up listener
      },
    };

    // Final check for immediate abort
    if (combinedSignal.aborted) {
      console.log(
        `${EMULATED_NAMESPACE}.summarizer: Instance aborted immediately after setup.`,
      );
      summarizerInstance.destroy();
      throw (
        instanceAbortController.signal.reason ??
        new DOMException("Summarizer creation aborted.", "AbortError")
      );
    }

    options.signal?.removeEventListener("abort", externalAbortHandler); // Clean up listener if successful

    return summarizerInstance;
  }

  /** Creates the `summarizer` API object */
  function createSummarizerApiObject() {
    const summarizerApi = {
      /** Check summarizer availability (depends on API key) */
      capabilities: async function () {
        // Reusing languageModel logic, as availability is the same
        const key = await ensureApiKey();
        return { available: key ? "readily" : "no" };
      },
      /** Check availability with specific options (simplified emulation) */
      availability: async function (options = {}) {
        // Emulation: Assume any option is available if the key exists.
        // A real implementation would check model support for languages/types.
        // 'downloadable'/'downloading' aren't applicable here.
        const key = await ensureApiKey();
        // TODO: Could add basic checks, e.g., if options.type is valid?
        return key ? "available" : "unavailable";
      },
      /** Create a new summarizer instance */
      create: async function (options = {}) {
        const key = await ensureApiKey();
        if (!key) {
          throw new Error(
            `${EMULATED_NAMESPACE}.summarizer: Cannot create instance, OpenRouter API Key is not configured.`,
          );
        }
        // Ignore monitor option in emulation
        const { monitor, ...restOptions } = options;
        if (monitor) {
          console.warn(
            `${EMULATED_NAMESPACE}.summarizer: 'monitor' option is ignored in this emulation.`,
          );
        }
        return createSummarizerInstance(key, restOptions);
      },
    };
    return summarizerApi;
  }

  // --- Initialization ---

  /**
   * Initializes the Chrome AI API emulators and attaches them to the window.
   * @async
   */
  async function init() {
    if (!NAMESPACE_TARGET[EMULATED_NAMESPACE]) {
      NAMESPACE_TARGET[EMULATED_NAMESPACE] = {};
      console.log(`${EMULATED_NAMESPACE}: Created global namespace.`);
    } else {
      console.log(`${EMULATED_NAMESPACE}: Using existing global namespace.`);
    }

    const attachedAPIs = [];

    // Initialize Prompt API (languageModel)
    if (!NAMESPACE_TARGET[EMULATED_NAMESPACE].languageModel) {
      NAMESPACE_TARGET[EMULATED_NAMESPACE].languageModel =
        createLanguageModelApiObject();
      attachedAPIs.push("languageModel");
    } else {
      console.warn(
        `${EMULATED_NAMESPACE}: languageModel already exists on namespace target. Skipping attachment.`,
      );
    }

    // Initialize Summarizer API
    if (!NAMESPACE_TARGET[EMULATED_NAMESPACE].summarizer) {
      NAMESPACE_TARGET[EMULATED_NAMESPACE].summarizer =
        createSummarizerApiObject();
      attachedAPIs.push("summarizer");
    } else {
      console.warn(
        `${EMULATED_NAMESPACE}: summarizer already exists on namespace target. Skipping attachment.`,
      );
    }

    if (attachedAPIs.length > 0) {
      console.log(
        `${EMULATED_NAMESPACE}: Chrome AI API emulator loaded. Attached: [${attachedAPIs.join(", ")}]. Access via: ${Object.keys(NAMESPACE_TARGET).includes(EMULATED_NAMESPACE) ? `window.${EMULATED_NAMESPACE}` : "unsafeWindow." + EMULATED_NAMESPACE}`,
      );
    } else {
      console.log(
        `${EMULATED_NAMESPACE}: Chrome AI API emulator loaded, but no new APIs were attached (already existed).`,
      );
    }

    // Check for API key status on load
    ensureApiKey();
  }

  init();
})();
