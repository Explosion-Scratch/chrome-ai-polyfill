// Common Basic Types
/**
 * Represents the availability status of an AI model or feature.
 * - "unavailable": The feature or requested options are not supported.
 * - "downloadable": Supported, but a download is required.
 * - "downloading": Supported, but a download is currently in progress.
 * - "available": Supported and ready to use without new downloads.
 */
type AIAvailabilityStatus =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

type AIResponseFormat = "plain-text" | "json" | "markdown";

/**
 * Callback function to monitor AI model creation, particularly for download progress.
 * @param monitor The EventTarget to which 'downloadprogress' events can be added.
 */
type AICreateMonitorCallback = (monitor: EventTarget) => void;

/**
 * Base options for creating AI instances, including an AbortSignal and a monitor callback.
 */
interface AIBaseCreateOptions {
  signal?: AbortSignal;
  monitor?: AICreateMonitorCallback;
}

/**
 * Base options for AI operations, typically including an AbortSignal.
 */
interface AIBaseOperationOptions {
  signal?: AbortSignal;
}

/**
 * Represents a QuotaExceededError, which is a DOMException with additional details.
 */
interface AIQuotaExceededError extends DOMException {
  name: "QuotaExceededError";
  /** The number of units (e.g., tokens) requested. */
  requested: number;
  /** The maximum number of units (e.g., tokens) allowed. */
  quota: number;
}

// --- Prompt API (LanguageModel) Types ---

/**
 * Represents the availability status of the language model specifically for the Prompt API.
 * - 'no': Model is not available.
 * - 'readily': Model is available and ready to use.
 * - 'after-download': Model needs to be downloaded before use.
 */
type AILanguageModelAvailabilityStatus = "no" | "readily" | "after-download";

/**
 * Capabilities of the language model for the Prompt API.
 */
interface AILanguageModelCapabilities {
  available: AILanguageModelAvailabilityStatus;
  /** Maximum number of input tokens the model can process. */
  maxInputTokens?: number; // From user script, not explicit in spec here
  /** Default temperature for generation. */
  defaultTemperature?: number;
  /** Default topK for generation. */
  defaultTopK?: number;
  /** Maximum temperature supported. */
  maxTemperature?: number;
  /** Maximum topK supported. */
  maxTopK?: number;
}

/**
 * Parameters for the language model, such as default and maximum temperature and topK.
 */
interface AILanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

/**
 * Specifies the type of an expected input for a language model session.
 */
type AILanguageModelMessageType = "text" | "image" | "audio";

/**
 * Defines an expected input type and associated languages for a language model session.
 */
interface AILanguageModelExpectedInput {
  type: AILanguageModelMessageType;
  languages?: string[]; // BCP 47 language tags
}

/**
 * Core options for creating a language model session.
 */
interface AILanguageModelCreateCoreOptions {
  topK?: number;
  temperature?: number;
  expectedInputs?: AILanguageModelExpectedInput[];
}

/**
 * Represents the role of a message in a language model conversation.
 */
type AILanguageModelMessageRole = "system" | "user" | "assistant";

/**
 * Content of a message, which can be text, image, or audio.
 */
type AILanguageModelMessageContentValue =
  | ImageBitmapSource
  | AudioBuffer
  | BufferSource
  | string;

/**
 * Represents a piece of content within a multimodal message.
 */
interface AILanguageModelMessageContentPart {
  type: AILanguageModelMessageType;
  content: AILanguageModelMessageContentValue;
}

/**
 * Represents a message in a language model conversation (canonical format).
 */
interface AILanguageModelMessage {
  role: AILanguageModelMessageRole;
  content: AILanguageModelMessageContentPart[];
}

/**
 * Shorthand for a simple text message in a language model conversation.
 */
interface AILanguageModelMessageShorthand {
  role: AILanguageModelMessageRole;
  content: string; // Shorthand for [{ type: "text", content: stringValue }]
}

/**
 * Input prompt for the language model. Can be a single string, a shorthand message,
 * or an array of canonical/shorthand messages.
 */
type AILanguageModelPromptInput =
  | string // Shorthand for a single user message with text content
  | AILanguageModelMessageShorthand // Single message with text content
  | AILanguageModelMessage // Single canonical message (potentially multimodal)
  | (AILanguageModelMessage | AILanguageModelMessageShorthand)[]; // Array of messages

/**
 * Type for the `initialPrompts` option.
 */
type AILanguageModelInitialPrompts = (
  | AILanguageModelMessage
  | AILanguageModelMessageShorthand
)[];

/**
 * Options for creating a language model session.
 */
interface AILanguageModelCreateOptions
  extends AILanguageModelCreateCoreOptions,
    AIBaseCreateOptions {
  systemPrompt?: string;
  initialPrompts?: AILanguageModelInitialPrompts;
}

/**
 * Represents a JSON schema object for structured output.
 * This is an opaque type; the actual schema object is passed.
 */
interface AILanguageModelResponseSchema {
  // Constructor: new (responseJSONSchemaObject: object) => AILanguageModelResponseSchema;
  // In practice, developers will likely pass a plain JS object.
}

/**
 * Options for a `prompt` or `promptStreaming` call.
 */
interface AILanguageModelPromptOptions extends AIBaseOperationOptions {
  /**
   * A JSON schema object or an instance of LanguageModelResponseSchema
   * to guide the model towards structured JSON output.
   */
  responseJSONSchema?: object | AILanguageModelResponseSchema;
  /**
   * Overrides the session's temperature for this specific call.
   * (Not in WebIDL, but common in implementations and user script)
   */
  temperature?: number;
  /**
   * Overrides the session's topK for this specific call.
   * (Not in WebIDL, but common in implementations and user script)
   */
  topK?: number;
  /**
   * Overrides the session's system prompt for this specific call.
   * (Not in WebIDL, but common in implementations and user script)
   */
  systemPrompt?: string;
}

/**
 * Options for an `append` call.
 */
interface AILanguageModelAppendOptions extends AIBaseOperationOptions {}

/**
 * Represents an active session with the language model.
 */
interface AILanguageModelSession extends EventTarget {
  /**
   * Generates a response to the input text.
   * @param input The prompt input.
   * @param options Optional parameters for this specific prompt call.
   * @returns A promise that resolves to the model's response string.
   */
  prompt(
    input: AILanguageModelPromptInput,
    options?: AILanguageModelPromptOptions
  ): Promise<string>;

  /**
   * Streams the response to the input text.
   * @param input The prompt input.
   * @param options Optional parameters for this specific prompt call.
   * @returns A ReadableStream of response string chunks.
   */
  promptStreaming(
    input: AILanguageModelPromptInput,
    options?: AILanguageModelPromptOptions
  ): ReadableStream<string>;

  /**
   * Appends messages to the session's context without prompting for an immediate response.
   * @param input The messages to append.
   * @param options Optional parameters for this append operation.
   */
  append(
    input: AILanguageModelPromptInput,
    options?: AILanguageModelAppendOptions
  ): Promise<void>;

  /**
   * Measures the token usage of a given prompt input for this session.
   * @param input The prompt input to measure.
   * @param options Optional parameters for this measurement.
   * @returns A promise that resolves to the estimated token count.
   */
  measureInputUsage(
    input: AILanguageModelPromptInput,
    options?: AIBaseOperationOptions // Based on WebIDL, no responseJSONSchema here
  ): Promise<number>;

  /** Current token usage of the session's context. */
  readonly inputUsage: number;
  /** Maximum token quota for the session's context. */
  readonly inputQuota: number;
  /** Event handler for the 'quotaoverflow' event. */
  onquotaoverflow: ((this: AILanguageModelSession, ev: Event) => any) | null;

  /** The topK parameter configured for this session. */
  readonly topK: number;
  /** The temperature parameter configured for this session. */
  readonly temperature: number;

  /**
   * Clones the current session, creating a new session with the same configuration and history.
   * @param options Options for cloning, e.g., a new AbortSignal.
   * @returns A promise that resolves to the new AILanguageModelSession.
   */
  clone(options?: AIBaseOperationOptions): Promise<AILanguageModelSession>; // AIBaseOperationOptions for signal

  /**
   * Destroys the session, releasing associated resources.
   */
  destroy(): void;

  /**
   * (Non-standard, from user script for convenience)
   * Counts tokens for a given prompt input, distinct from session history.
   * @param input The prompt input to count tokens for.
   * @returns A promise resolving to the token count.
   */
  countPromptTokens?(input: AILanguageModelPromptInput): Promise<number>;
}

/**
 * Interface for the Prompt API (`ai.languageModel`).
 */
interface AIPromptAPI {
  /**
   * Checks the availability and capabilities of the language model.
   * This is the older capabilities check.
   */
  capabilities(): Promise<AILanguageModelCapabilities>;

  /**
   * Creates a new language model session.
   * @param options Configuration options for the session.
   * @returns A promise that resolves to an AILanguageModelSession.
   */
  create(
    options?: AILanguageModelCreateOptions
  ): Promise<AILanguageModelSession>;

  /**
   * Checks the availability of the language model with specific core options.
   * This is the newer availability check from the explainer.
   */
  availability(
    options?: AILanguageModelCreateCoreOptions
  ): Promise<AIAvailabilityStatus>;

  /**
   * Retrieves the default and maximum parameters for the language model.
   */
  params(): Promise<AILanguageModelParams | null>;
}

// --- Writing Assistance APIs (Summarizer, Writer, Rewriter) ---

/**
 * Base create options for Writing Assistance APIs.
 */
interface AIWritingAssistanceBaseCreateOptions extends AIBaseCreateOptions {
  sharedContext?: string;
  expectedInputLanguages?: string[]; // BCP 47 language tags
  expectedContextLanguages?: string[]; // BCP 47 language tags
  outputLanguage?: string; // BCP 47 language tag
}

/**
 * Base instance for Writing Assistance APIs.
 */
interface AIWritingAssistanceBaseInstance {
  /** The maximum number of input tokens the model can handle. */
  readonly inputQuota: number;
  /**
   * Measures the estimated token usage for a given text input.
   * @param text The text to measure.
   * @param options Optional parameters for the measurement.
   * @returns A promise that resolves to the estimated token count.
   */
  measureInputUsage(
    text: string,
    options?: AIBaseOperationOptions
  ): Promise<number>;
  /**
   * Destroys the instance, releasing associated resources.
   */
  destroy(): void;
  /**
   * Clones the current instance.
   * @param options Options for cloning, e.g., a new AbortSignal.
   */
  clone(options?: AIBaseCreateOptions): Promise<this>; // `this` refers to the specific instance type
}

// ** Summarizer API Types **

/** Type of summary to generate. */
type AISummarizerType = "key-points" | "tl;dr" | "teaser" | "headline";
/** Output format for the summary. */
type AISummarizerFormat = AIResponseFormat;
/** Desired length of the summary. */
type AISummarizerLength = "short" | "medium" | "long";

/** Options for creating a Summarizer instance. */
interface AISummarizerCreateOptions
  extends AIWritingAssistanceBaseCreateOptions {
  type?: AISummarizerType;
  format?: AISummarizerFormat;
  length?: AISummarizerLength;
}

/** Options for a summarization call. */
interface AISummarizeOptions extends AIBaseOperationOptions {
  context?: string;
}

/** Represents a Summarizer instance. */
interface AISummarizerInstance extends AIWritingAssistanceBaseInstance {
  /**
   * Generates a summary of the input text.
   * @param text The text to summarize.
   * @param options Optional parameters for this summarization call.
   * @returns A promise that resolves to the summary string.
   */
  summarize(text: string, options?: AISummarizeOptions): Promise<string>;
  /**
   * Streams the summary of the input text.
   * @param text The text to summarize.
   * @param options Optional parameters for this summarization call.
   * @returns A ReadableStream of summary string chunks.
   * The Summarizer API docs mention `summarizeStreaming` yields accumulated output.
   * The Writing Assistance Explainer implies deltas for all streaming methods.
   * Assuming deltas as per the explainer's intent for consistency, but actual Chrome might differ.
   */
  summarizeStreaming(
    text: string,
    options?: AISummarizeOptions
  ): ReadableStream<string>;
}

/** Interface for the Summarizer API (`ai.summarizer`). */
interface AISummarizerAPI {
  /**
   * Checks the availability of the summarizer with specific options.
   * @param options Configuration options to check availability for.
   */
  availability(
    options?: AISummarizerCreateOptions
  ): Promise<AIAvailabilityStatus>;
  /**
   * Creates a new summarizer instance.
   * @param options Configuration options for the summarizer.
   * @returns A promise that resolves to an AISummarizerInstance.
   */
  create(options?: AISummarizerCreateOptions): Promise<AISummarizerInstance>;

  /**
   * (Old shape, from initial docs & playground JS)
   * Checks the availability of the language model.
   */
  capabilities?(): Promise<{ available: AILanguageModelAvailabilityStatus }>;
}

// ** Writer API Types **

/** Tone for the generated text. */
type AIWriterTone = "as-is" | "more-formal" | "more-casual"; // string for custom tones
/** Desired length for the generated text. */
type AIWriterLength = "as-is" | "shorter" | "longer"; // string for custom lengths

/** Options for creating a Writer instance. */
interface AIWriterCreateOptions extends AIWritingAssistanceBaseCreateOptions {
  tone?: AIWriterTone;
  length?: AIWriterLength;
}

/** Options for a write call. */
interface AIWriteOptions extends AIBaseOperationOptions {
  context?: string;
}

/** Represents a Writer instance. */
interface AIWriterInstance extends AIWritingAssistanceBaseInstance {
  /**
   * Generates new text based on a task prompt.
   * @param taskPrompt The prompt describing the writing task.
   * @param options Optional parameters for this writing call.
   * @returns A promise that resolves to the generated text string.
   */
  write(taskPrompt: string, options?: AIWriteOptions): Promise<string>;
  /**
   * Streams the generated text based on a task prompt.
   * @param taskPrompt The prompt describing the writing task.
   * @param options Optional parameters for this writing call.
   * @returns A ReadableStream of generated text string chunks (accumulated, as per explainer).
   */
  writeStreaming(
    taskPrompt: string,
    options?: AIWriteOptions
  ): ReadableStream<string>;
}

/** Interface for the Writer API (`ai.writer`). */
interface AIWriterAPI {
  /**
   * Checks the availability of the writer with specific options.
   * @param options Configuration options to check availability for.
   */
  availability(options?: AIWriterCreateOptions): Promise<AIAvailabilityStatus>;
  /**
   * Creates a new writer instance.
   * @param options Configuration options for the writer.
   * @returns A promise that resolves to an AIWriterInstance.
   */
  create(options?: AIWriterCreateOptions): Promise<AIWriterInstance>;
}

// ** Rewriter API Types **

/** Tone guideline for rewriting. */
type AIRewriterTone = "more-format" | "as-is" | "more-casual";
/** Length guideline for rewriting. */
type AIRewriterLength = "shorter" | "longer" | "as-is";

/** Options for creating a Rewriter instance. */
interface AIRewriterCreateOptions extends AIWritingAssistanceBaseCreateOptions {
  tone?: AIRewriterTone;
  length?: AIRewriterLength;
  format?: AIResponseFormat;
}

/** Options for a rewrite call. */
interface AIRewriteOptions extends AIBaseOperationOptions {
  /** Specific instructions for how to rewrite the text (required). */
  instructions: string;
  context?: string;
  tone?: AIRewriterTone;
  length?: AIRewriterLength;
}

/** Represents a Rewriter instance. */
interface AIRewriterInstance extends AIWritingAssistanceBaseInstance {
  /**
   * Rewrites the input text based on specified instructions.
   * @param text The text to rewrite.
   * @param options Parameters for this rewriting call, including `instructions`.
   * @returns A promise that resolves to the rewritten text string.
   */
  rewrite(text: string, options: AIRewriteOptions): Promise<string>;
  /**
   * Streams the rewritten text based on specified instructions.
   * @param text The text to rewrite.
   * @param options Parameters for this rewriting call, including `instructions`.
   * @returns A ReadableStream of rewritten text string chunks (accumulated, as per explainer).
   */
  rewriteStreaming(
    text: string,
    options: AIRewriteOptions
  ): ReadableStream<string>;
}

/** Interface for the Rewriter API (`ai.rewriter`). */
interface AIRewriterAPI {
  /**
   * Checks the availability of the rewriter with specific options.
   * @param options Configuration options to check availability for.
   */
  availability(
    options?: AIRewriterCreateOptions
  ): Promise<AIAvailabilityStatus>;
  /**
   * Creates a new rewriter instance.
   * @param options Configuration options for the rewriter.
   * @returns A promise that resolves to an AIRewriterInstance.
   */
  create(options?: AIRewriterCreateOptions): Promise<AIRewriterInstance>;
}

// --- Translator API Types ---

/** Options for creating a Translator instance. */
interface AITranslatorCreateOptions extends AIBaseCreateOptions {
  /** BCP 47 language tag for the source language (required). */
  sourceLanguage: string;
  /** BCP 47 language tag for the target language (required). */
  targetLanguage: string;
}

/** Options for a translation call. */
interface AITranslateOptions extends AIBaseOperationOptions {}

/** Represents a Translator instance. */
interface AITranslatorInstance {
  // No explicit base in explainer, but similar methods
  /**
   * Translates the input text.
   * @param text The text to translate.
   * @param options Optional parameters for this translation call.
   * @returns A promise that resolves to the translated text string.
   */
  translate(text: string, options?: AITranslateOptions): Promise<string>;
  /**
   * Streams the translated text.
   * @param text The text to translate.
   * @param options Optional parameters for this translation call.
   * @returns A ReadableStream of translated text string chunks.
   */
  translateStreaming(
    text: string,
    options?: AITranslateOptions
  ): ReadableStream<string>;

  /** The maximum number of input tokens/characters the model can handle. */
  readonly inputQuota: number;
  /**
   * Measures the estimated usage for a given text input.
   * @param text The text to measure.
   * @param options Optional parameters for the measurement.
   * @returns A promise that resolves to the estimated usage count.
   */
  measureInputUsage(
    text: string,
    options?: AIBaseOperationOptions
  ): Promise<number>;
  /**
   * Destroys the instance, releasing associated resources.
   */
  destroy(): void;
  /**
   * Clones the current instance.
   * @param options Options for cloning, e.g., a new AbortSignal.
   */
  clone(options?: AIBaseCreateOptions): Promise<this>;
}

/** Interface for the Translator API (`ai.Translator`). */
interface AITranslatorAPI {
  /**
   * Checks the availability of translation for the given language pair and options.
   * @param options Configuration options to check availability for.
   */
  availability(
    options: AITranslatorCreateOptions
  ): Promise<AIAvailabilityStatus>;
  /**
   * Creates a new translator instance.
   * @param options Configuration options for the translator.
   * @returns A promise that resolves to an AITranslatorInstance.
   */
  create(options: AITranslatorCreateOptions): Promise<AITranslatorInstance>;

  /**
   * (User script addition, not in spec)
   * Checks if a specific language pair is available for translation.
   */
  languagePairAvailable?(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<AIAvailabilityStatus>;
}

// --- LanguageDetector API Types ---

/** Options for creating a LanguageDetector instance. */
interface AILanguageDetectorCreateOptions extends AIBaseCreateOptions {
  expectedInputLanguages?: string[]; // BCP 47 language tags
}

/** Result of a language detection operation. */
interface AILanguageDetectionResult {
  /** BCP 47 language tag of the detected language. */
  detectedLanguage: string;
  /** Confidence score (0.0 to 1.0) for the detection. */
  confidence: number;
}

/** Options for a detection call. */
interface AIDetectOptions extends AIBaseOperationOptions {}

/** Represents a LanguageDetector instance. */
interface AILanguageDetectorInstance {
  // No explicit base in explainer, but similar methods
  /**
   * Detects the language(s) in the input text.
   * @param text The text to analyze.
   * @param options Optional parameters for this detection call.
   * @returns A promise that resolves to an array of AILanguageDetectionResult objects,
   *          sorted by confidence in descending order.
   */
  detect(
    text: string,
    options?: AIDetectOptions
  ): Promise<AILanguageDetectionResult[]>;

  /** The maximum number of input tokens/characters the model can handle. */
  readonly inputQuota: number;
  /**
   * Measures the estimated usage for a given text input.
   * @param text The text to measure.
   * @param options Optional parameters for the measurement.
   * @returns A promise that resolves to the estimated usage count.
   */
  measureInputUsage(
    text: string,
    options?: AIBaseOperationOptions
  ): Promise<number>;
  /**
   * Destroys the instance, releasing associated resources.
   */
  destroy(): void;
  /**
   * Clones the current instance.
   * @param options Options for cloning, e.g., a new AbortSignal.
   */
  clone(options?: AIBaseCreateOptions): Promise<this>;
}

/** Interface for the LanguageDetector API (`ai.LanguageDetector`). */
interface AILanguageDetectorAPI {
  /**
   * Checks the availability of language detection with specific options.
   * @param options Configuration options to check availability for.
   */
  availability(
    options?: AILanguageDetectorCreateOptions
  ): Promise<AIAvailabilityStatus>;
  /**
   * Creates a new language detector instance.
   * @param options Configuration options for the language detector.
   * @returns A promise that resolves to an AILanguageDetectorInstance.
   */
  create(
    options?: AILanguageDetectorCreateOptions
  ): Promise<AILanguageDetectorInstance>;
}

// --- Global `ai` Namespace on Window ---
interface AI {
  /** The Prompt API, for general-purpose interaction with language models. */
  languageModel: AIPromptAPI;
  /** The Summarizer API, for generating summaries of text. */
  summarizer: AISummarizerAPI;
  /** The Writer API, for generating new text based on prompts. */
  writer: AIWriterAPI;
  /** The Rewriter API, for transforming existing text. */
  rewriter: AIRewriterAPI;
  /** The Translator API, for translating text between languages. */
  Translator: AITranslatorAPI; // Note: Capital 'T' as per explainer's examples
  /** The LanguageDetector API, for detecting the language of text. */
  LanguageDetector: AILanguageDetectorAPI; // Note: Capital 'L' as per explainer's examples

  // The following are typically top-level on window/self rather than under `ai`
  // but included here if `window.ai.Summarizer` etc. is also a pattern.
  // The Summarizer API docs show `self.ai.summarizer` and `window.Summarizer`.
  // The user script places these under `window.ai` as aliases.
  Summarizer?: AISummarizerAPI; // Alias for ai.summarizer for new API shape

  /**
   * (Non-standard, from Chrome initial explorations for Gemini Nano)
   * A general capability check.
   * @returns Promise resolving to true if a text session can be created.
   */
  canCreateTextSession?(): Promise<boolean>;
  /**
   * (Non-standard, from Chrome initial explorations for Gemini Nano)
   * A general capability check.
   * @returns Promise resolving to true if a generic session can be created.
   */
  canCreateGenericSession?(): Promise<boolean>;
  /**
   * (Non-standard, from Chrome initial explorations for Gemini Nano)
   * Shortcut to create a text session, likely equivalent to `ai.languageModel.create()`.
   * @returns Promise resolving to an AILanguageModelSession.
   */
  createTextSession?(): Promise<AILanguageModelSession>;
}

declare global {
  interface Window {
    ai: AI;

    // The newer Summarizer API shape might also be directly on window
    Summarizer?: AISummarizerAPI;
    // LanguageModel may also be top-level from some explainers
    LanguageModel?: AIPromptAPI;
  }

  // Make AISummarizerType etc. globally available as they are used in playground
  type AISummarizerType = "key-points" | "tl;dr" | "teaser" | "headline";
  type AISummarizerFormat = AIResponseFormat;
  type AISummarizerLength = "short" | "medium" | "long";
  // For playground JS:
  interface AISummarizer extends AISummarizerInstance {} // Alias for instance
  interface DownloadProgressEvent extends ProgressEvent {} // Alias for ProgressEvent
  interface AICreateMonitor extends EventTarget {} // Alias for EventTarget
}

// To use ImageBitmapSource, AudioBuffer, BufferSource, ensure appropriate lib in tsconfig.json
// e.g., "lib": ["ES2020", "DOM", "DOM.Iterable"]
// ImageBitmapSource is part of "DOM"
// AudioBuffer is part of "WebAudio" (might need to add "WebAudio" to lib or install @types/webaudio)
// BufferSource is part of "DOM" (ArrayBuffer | ArrayBufferView)
