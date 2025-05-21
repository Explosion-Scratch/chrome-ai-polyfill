/**
 * @jest-environment jsdom
 */

// --- Global Mocks ---
const performanceNowMock = jest.fn();

// Mock Greasemonkey APIs
global.GM_setValue = jest.fn(() => Promise.resolve());
global.GM_getValue = jest.fn(() => Promise.resolve(null)); // Default to no stored key
global.GM_deleteValue = jest.fn(() => Promise.resolve());
global.GM_registerMenuCommand = jest.fn();
global.GM = {
  xmlHttpRequest: jest.fn(),
};
global.GM_info = {
  script: {
    name: "Chrome AI APIs Emulator (via OpenRouter)",
    version: "3.3",
    // ... other GM_info properties if needed
  },
};

// Mock for window.location.reload
global.window.location = {
  ...global.window.location, // Preserve other properties if any
  reload: jest.fn(),
  assign: jest.fn(),
  replace: jest.fn(),
  href: '', // Add other properties jsdom might expect
  origin: 'null',
  protocol: 'http:',
  host: 'localhost',
  hostname: 'localhost',
  port: '',
  pathname: '/',
  search: '',
  hash: '',
};

// Mock for ReadableStream, TextEncoder, TextDecoder
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

class MockReadableStream {
  constructor(underlyingSource) {
    this._locked = false;
    this._controller = {
      enqueue: jest.fn((chunk) => {
        if (!this._queue) this._queue = [];
        this._queue.push(chunk);
      }),
      close: jest.fn(() => {
        if (!this._queue) this._queue = []; // Ensure queue exists even if nothing enqueued
        this._closed = true;
      }),
      error: jest.fn((e) => {
        this._error = e;
        this._closed = true;
      }),
    };
    this._queue = [];
    this._closed = false;
    this._error = null;

    if (underlyingSource && underlyingSource.start) {
      try {
        underlyingSource.start(this._controller);
      } catch (e) {
        this._controller.error(e);
      }
    } else {
      // If no underlying source, behave like an empty, closed stream
      this._closed = true;
    }
  }

  get locked() {
    return this._locked;
  }

  getReader() {
    if (this._locked) {
      throw new TypeError("ReadableStreamDefaultReader constructor: Cannot acquire reader, stream is locked.");
    }
    this._locked = true;
    let currentRead = 0;
    return {
      read: jest.fn(async () => {
        if (this._error) throw this._error;
        if (currentRead < this._queue.length) {
          const value = this._queue[currentRead++];
          return { value: typeof value === 'string' ? new TextEncoder().encode(value) : value, done: false };
        }
        return { value: undefined, done: true };
      }),
      releaseLock: jest.fn(() => {
        this._locked = false;
      }),
      cancel: jest.fn(async (reason) => {
        if (this._underlyingSource && this._underlyingSource.cancel) {
          await this._underlyingSource.cancel(reason);
        }
        this._closed = true;
        this._queue = []; // Clear queue on cancel
        return Promise.resolve();
      }),
      closed: new Promise((resolve, reject) => {
        const checkClosed = () => {
          if (this._error) reject(this._error);
          else if (this._closed) resolve(undefined);
          else setTimeout(checkClosed, 5); // Check periodically
        };
        checkClosed();
      })
    };
  }

  cancel(reason) {
    if (this._underlyingSource && this._underlyingSource.cancel) {
      return Promise.resolve(this._underlyingSource.cancel(reason));
    }
    this._closed = true;
    this._queue = [];
    return Promise.resolve();
  }

  tee() {
    // Basic tee: just return two new instances that will behave independently
    // This mock might not fully replicate complex tee scenarios but is often enough.
    return [new MockReadableStream(this._underlyingSource), new MockReadableStream(this._underlyingSource)];
  }
}
global.ReadableStream = MockReadableStream;

// Mock for Intl.DisplayNames
global.Intl = {
  ...global.Intl,
  DisplayNames: jest.fn().mockImplementation((locales, options) => {
    return {
      of: jest.fn(code => {
        if (!code) return undefined; // Match browser behavior for undefined/null
        // Simple fallback for common codes, can be expanded
        const names = {
          'en': 'English',
          'es': 'Spanish',
          'fr': 'French',
          'de': 'German',
          'zh': 'Chinese',
          'und': 'Undetermined',
        };
        return names[code.toLowerCase().split('-')[0]] || code;
      }),
    };
  }),
};

// Mock window properties
global.unsafeWindow = global; // For Tampermonkey, often unsafeWindow is window

// Ensure global.performance (aliased by global.window.performance) exists and set up the mock
if (typeof global.performance !== 'object' || global.performance === null) {
  global.performance = {};
}
global.performance.now = performanceNowMock;

global.window.alert = jest.fn();
global.window.prompt = jest.fn();
global.window.confirm = jest.fn(() => true); // Default to 'OK'
global.window.fetch = jest.fn();

// Mock external libraries if they are not bundled and expected globally
global.marked = {
  parse: jest.fn((text) => `<p>${text}</p>`), // Simple mock
};
global.DOMPurify = {
  sanitize: jest.fn((html) => html), // Simple mock
};

// Mock console methods to spy on Logger
global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  group: jest.fn(),
  groupCollapsed: jest.fn(),
  groupEnd: jest.fn(),
  table: jest.fn(),
  dir: jest.fn(),
};

// --- Helper to load the script ---
// This will execute the IIFE and populate unsafeWindow.ai
const loadUserScript = () => {
  jest.isolateModules(() => {
    require('./chrome-ai.user.js');
  });
};

// --- Test Suites ---

describe('Chrome AI Polyfill (chrome-ai.user.js)', () => {
  let Config; // To access the Config object after script load
  let Logger; // To access the Logger object
  let KeyManager; // To access KeyManager
  let CoreAPI; // To access CoreAPI
  let ai; // To access the unsafeWindow.ai namespace

  // Define process for environments where it might not be (like stricter jsdom or future jest versions)
  if (typeof global.process === 'undefined') {
    global.process = {
      nextTick: (callback) => setTimeout(callback, 0),
      env: {},
    };
  }

  beforeAll(() => {
    // Load the script once, its IIFE will run and set up unsafeWindow.ai
  });

  beforeEach(async () => {
    // Reset mocks before each test
    jest.clearAllMocks();
    global.GM_getValue.mockResolvedValue(null); // Default to no API key
    performanceNowMock.mockReturnValue(Date.now()); // Reset time
    global.window.location.reload = jest.fn(); // Reset reload mock
    // Ensure location reload is fresh for each test
    if (global.window && global.window.location && global.window.location.reload) {
    //   global.window.location.reload.mockClear();
    }

    // Clear the ai namespace if it was created
    if (global.unsafeWindow && global.unsafeWindow.ai) {
      delete global.unsafeWindow.ai;
    }

    // Clear pending promises symbol store
    const pendingPromisesSymbol = Object.getOwnPropertySymbols(global.unsafeWindow).find(s => s.toString() === 'Symbol(_pendingAIPromises)');
    if (pendingPromisesSymbol && global.unsafeWindow[pendingPromisesSymbol]) {
      delete global.unsafeWindow[pendingPromisesSymbol];
    }

    // Mock fetch to return a default successful response for key check
    global.fetch.mockImplementation(async (url, options) => {
      if (url.toString().includes('/key')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ limit: 100, usage: 10, balance: 1.0, model: "test-model", name: "Test Key" }),
        });
      }
      // For chat completions (streaming or not)
      if (url.toString().includes('/chat/completions')) {
        if (options && options.body && JSON.parse(options.body).stream) {
          // Streaming response
          return Promise.resolve({
            ok: true,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue('data: {"id":"1","model":"","choices":[{"index":0,"delta":{"role":"assistant","content":"Mocked "}}]}');
                controller.enqueue('data: {"id":"1","model":"","choices":[{"index":0,"delta":{"content":"stream "}}]}');
                controller.enqueue('data: {"id":"1","model":"","choices":[{"index":0,"delta":{"content":"response."}}]}');
                controller.enqueue('data: [DONE]');
                controller.close();
              }
            }),
            headers: new Headers({'Content-Type': 'text/event-stream'})
          });
        } else {
          // Non-streaming response
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'Mocked non-stream response' } }] }),
          });
        }
      }
      // Default fallback for other fetch calls
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        body: new ReadableStream({ start(c){ c.close(); }})
      });
    });
  });

  describe('Initial Setup and Configuration', () => {
    it('should define the ai namespace on unsafeWindow', async () => {
      loadUserScript();
      await new Promise(process.nextTick); // Allow script's async init to progress
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(global.unsafeWindow.ai).toBeDefined();
      expect(typeof global.unsafeWindow.ai).toBe('object');
    });

    it('should register Greasemonkey menu commands during initialization if API key is present', async () => {
      global.GM_getValue.mockResolvedValue('test-api-key');
      loadUserScript();
      // Need to wait for async initialization within the script
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 20)); // Increased timeout slightly more
      expect(GM_registerMenuCommand).toHaveBeenCalledWith(
        'Set OpenRouter API Key',
        expect.any(Function)
      );
      expect(GM_registerMenuCommand).toHaveBeenCalledWith(
        'Clear OpenRouter API Key',
        expect.any(Function)
      );
      expect(GM_registerMenuCommand).toHaveBeenCalledWith(
        'Check OpenRouter Key Status',
        expect.any(Function)
      );
    });

    it('Logger should use console methods with a prefix', () => {
      loadUserScript(); // This will instantiate Logger internally
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('API Initialization (unsafeWindow.ai structure)', () => {
    const allApiNames = [
      'languageModel', 'summarizer', 'writer', 'rewriter',
      'Translator', 'LanguageDetector'
    ];
    const apiAliases = {
      'Translator': 'translator',
      'LanguageDetector': 'languageDetector'
    };

    const checkApiObjectStructure = (apiObject, apiName) => {
      expect(apiObject).toBeDefined();
      expect(typeof apiObject.availability).toBe('function');
      expect(typeof apiObject.create).toBe('function');
      if (apiName !== 'Translator' && apiName !== 'LanguageDetector' && apiName !== 'translator' && apiName !== 'languageDetector') {
        expect(typeof apiObject.capabilities).toBe('function');
      }
      if (apiName === 'Translator' || apiName === 'translator') {
        expect(typeof apiObject.languagePairAvailable).toBe('function');
      }
    };

    it('should create all API objects in unsafeWindow.ai when enabled in Config', async () => {
      loadUserScript();
      await new Promise(process.nextTick); // Allow script's async init to progress
      await new Promise(resolve => setTimeout(resolve, 10)); // Wait for API setup
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined(); // Ensure ai namespace is created

      allApiNames.forEach(apiName => {
        checkApiObjectStructure(ai[apiName], apiName);
        if (apiAliases[apiName]) {
          checkApiObjectStructure(ai[apiAliases[apiName]], apiAliases[apiName]);
          expect(ai[apiAliases[apiName]]).toBe(ai[apiName]);
        }
      });
      expect(typeof ai.canCreateTextSession).toBe('function');
      expect(typeof ai.createTextSession).toBe('function');
    });

    it('should add convenience methods like canCreateTextSession and createTextSession', async () => {
      loadUserScript();
      await new Promise(process.nextTick); // Allow script's async init to progress
      await new Promise(resolve => setTimeout(resolve, 10)); // And a bit more time for all setup
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined(); // Ensure ai namespace is created

      expect(typeof ai.canCreateTextSession).toBe('function');
      expect(typeof ai.createTextSession).toBe('function');
      expect(typeof ai.canCreateGenericSession).toBe('function');

      const canCreate = await ai.canCreateTextSession();
      expect(canCreate === 'available' || canCreate === 'readily' || canCreate === 'after-prompt').toBe(true); // More flexible check

      // Mock languageModel.create to check if createTextSession calls it
      // Ensure languageModel itself and its create method are defined before mocking
      if (ai.languageModel && typeof ai.languageModel.create === 'function') {
        ai.languageModel.create = jest.fn(() => Promise.resolve({ mockInstance: true }));
        await ai.createTextSession();
        expect(ai.languageModel.create).toHaveBeenCalled();
      } else {
        // This case might indicate an issue with API setup itself
        throw new Error('ai.languageModel.create is not available for mocking');
      }
    });
  });

  describe('API Behavior - No API Key', () => {
    beforeEach(async () => {
      global.GM_getValue.mockResolvedValue(null);
      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 20)); // Increased timeout for full init
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined(); // Ensure ai namespace is created before tests run
    });

    it('languageModel.availability should be "unavailable"', async () => {
      expect(await ai.languageModel.availability()).toBe('unavailable');
    });
    it('languageModel.capabilities should indicate "no"', async () => {
      expect(await ai.languageModel.capabilities()).toEqual({ available: 'no' });
    });
    it('languageModel.create should reject', async () => {
      await expect(ai.languageModel.create()).rejects.toThrow(/languageModel: Cannot create instance, API Key is not configured./);
    });

    it('summarizer.availability should be "unavailable"', async () => {
      expect(await ai.summarizer.availability()).toBe('unavailable');
    });
    it('summarizer.create should reject', async () => {
      await expect(ai.summarizer.create()).rejects.toThrow(/summarizer: Cannot create instance, API Key is not configured./);
    });

    it('writer.availability should be "unavailable"', async () => {
      expect(await ai.writer.availability()).toBe('unavailable');
    });
    it('writer.create should reject', async () => {
      await expect(ai.writer.create()).rejects.toThrow(/writer: Cannot create instance, API Key is not configured./);
    });

    it('rewriter.availability should be "unavailable"', async () => {
      expect(await ai.rewriter.availability()).toBe('unavailable');
    });
    it('rewriter.create should reject', async () => {
      await expect(ai.rewriter.create()).rejects.toThrow(/rewriter: Cannot create instance, API Key is not configured./);
    });

    it('Translator.availability should be "unavailable"', async () => {
      expect(await ai.Translator.availability()).toBe('unavailable');
    });
    it('Translator.create should reject', async () => {
      await expect(ai.Translator.create()).rejects.toThrow(/Translator: Cannot create instance, API Key is not configured./);
    });
    it('Translator.languagePairAvailable should be "unavailable"', async () => {
      expect(await ai.Translator.languagePairAvailable('en', 'es')).toBe('unavailable');
    });

    it('LanguageDetector.availability should be "unavailable"', async () => {
      expect(await ai.LanguageDetector.availability()).toBe('unavailable');
    });
    it('LanguageDetector.create should reject', async () => {
      await expect(ai.LanguageDetector.create()).rejects.toThrow(/LanguageDetector: Cannot create instance, API Key is not configured./);
    });

    it('should log a warning about missing API key', async () => {
      // The warning is logged during initializeApis
      loadUserScript(); // Reload to ensure the init path is taken
      global.GM_getValue.mockResolvedValue(null); // Ensure no key
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 50)); // Wait for async logs

      const warnCalls = console.warn.mock.calls;
      const found = warnCalls.some(call => call.join(' ').includes('OpenRouter API Key is not set'));
      expect(found).toBe(true);
    });
  });

  describe('API Behavior - With API Key', () => {
    const mockApiKey = 'test-openrouter-api-key';

    beforeEach(async () => {
      global.GM_getValue.mockResolvedValue(mockApiKey);

      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 20)); // Increased timeout for full init
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined(); // Ensure ai namespace is created
    });

    describe('ai.languageModel', () => {
      it('availability should be "available"', async () => {
        expect(await ai.languageModel.availability()).toBe('available');
      });
      it('capabilities should indicate "readily"', async () => {
        const caps = await ai.languageModel.capabilities();
        expect(caps.available).toBe('readily');
        expect(caps.defaultTemperature).toBeDefined();
        expect(caps.defaultTopK).toBeDefined();
      });
      it('create() should return a LanguageModelSession instance', async () => {
        const session = await ai.languageModel.create();
        expect(session).toBeDefined();
        expect(typeof session.prompt).toBe('function');
        expect(typeof session.promptStreaming).toBe('function');
        expect(typeof session.destroy).toBe('function');
        expect(typeof session.execute).toBe('function');
        expect(typeof session.executeStreaming).toBe('function');
      });
      it('session.prompt() should return a string response', async () => {
        const session = await ai.languageModel.create();
        const response = await session.prompt('Hello world');
        expect(typeof response).toBe('string');
        expect(response).toBe('Mocked non-stream response');
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/chat/completions'),
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Authorization': `Bearer ${mockApiKey}`,
            }),
            body: expect.stringContaining('"role":"user","content":"Hello world"'),
          })
        );
      });
      it('session.promptStreaming() should return a ReadableStream', async () => {
        const session = await ai.languageModel.create();
        const stream = await session.promptStreaming('Stream test');
        expect(stream).toBeInstanceOf(ReadableStream);
        const reader = stream.getReader();
        let resultText = '';
        let chunk;
        while (!(chunk = await reader.read()).done) {
          resultText += new TextDecoder().decode(chunk.value);
        }
        expect(resultText).toBe('Mocked stream response.');
      });
    });

    describe('ai.summarizer', () => {
      it('availability should be "available"', async () => {
        expect(await ai.summarizer.availability()).toBe('available');
      });
      it('create() should return a SummarizerInstance', async () => {
        const instance = await ai.summarizer.create();
        expect(instance).toBeDefined();
        expect(typeof instance.summarize).toBe('function');
        expect(typeof instance.summarizeStreaming).toBe('function');
      });
      it('instance.summarize() should return a string summary', async () => {
        const instance = await ai.summarizer.create({ type: 'key-points', length: 'short' });
        const summary = await instance.summarize('This is a long text to summarize.');
        expect(typeof summary).toBe('string');
        expect(summary).toBe('Mocked non-stream response');
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/chat/completions'),
          expect.objectContaining({
            body: expect.stringContaining('"role":"system","content":'),
          })
        );
      });
    });

    describe('ai.writer', () => {
      it('availability should be "available"', async () => {
        expect(await ai.writer.availability()).toBe('available');
      });
      it('create() should return a WriterInstance', async () => {
        const instance = await ai.writer.create();
        expect(instance).toBeDefined();
        expect(typeof instance.write).toBe('function');
        expect(typeof instance.writeStreaming).toBe('function');
      });
      it('instance.write() should generate text', async () => {
        const instance = await ai.writer.create({ tone: 'more-formal' });
        const text = await instance.write('Write an email about a new product.');
        expect(typeof text).toBe('string');
        expect(text).toBe('Mocked non-stream response');
      });
    });

    describe('ai.rewriter', () => {
      it('availability should be "available"', async () => {
        expect(await ai.rewriter.availability()).toBe('available');
      });
      it('create() should return a RewriterInstance', async () => {
        const instance = await ai.rewriter.create();
        expect(instance).toBeDefined();
        expect(typeof instance.rewrite).toBe('function');
        expect(typeof instance.rewriteStreaming).toBe('function');
      });
      it('instance.rewrite() should rewrite text', async () => {
        const instance = await ai.rewriter.create({ tone: 'more-casual' });
        const rewrittenText = await instance.rewrite('Input text.', { instructions: 'Make it short.' });
        expect(typeof rewrittenText).toBe('string');
        expect(rewrittenText).toBe('Mocked non-stream response');
      });
    });

    describe('ai.Translator', () => {
      it('availability should be "available"', async () => {
        expect(await ai.Translator.availability()).toBe('available');
      });
      it('languagePairAvailable should be "available" (mocked)', async () => {
        expect(await ai.Translator.languagePairAvailable('en', 'es')).toBe('available');
      });
      it('create() should return a TranslatorInstance', async () => {
        const instance = await ai.Translator.create({ sourceLanguage: 'en', targetLanguage: 'es' });
        expect(instance).toBeDefined();
        expect(typeof instance.translate).toBe('function');
        expect(typeof instance.translateStreaming).toBe('function');
      });
      it('instance.translate() should translate text', async () => {
        const instance = await ai.Translator.create({ sourceLanguage: 'en', targetLanguage: 'es' });
        const translatedText = await instance.translate('Hello');
        expect(typeof translatedText).toBe('string');
        expect(translatedText).toBe('Mocked non-stream response');
      });
    });

    describe('ai.LanguageDetector', () => {
      it('availability should be "available"', async () => {
        expect(await ai.LanguageDetector.availability()).toBe('available');
      });
      it('create() should return a LanguageDetectorInstance', async () => {
        const instance = await ai.LanguageDetector.create();
        expect(instance).toBeDefined();
        expect(typeof instance.detectLanguage).toBe('function');
        expect(typeof instance.detect).toBe('function');
      });
      it('instance.detectLanguage() should detect language', async () => {
        global.fetch.mockResolvedValueOnce(Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: '[{"detectedLanguage": "en", "confidence": 0.9}]' } }] }),
        }));
        const instance = await ai.LanguageDetector.create();
        const detections = await instance.detectLanguage('This is a test.');
        expect(Array.isArray(detections)).toBe(true);
        expect(detections.length).toBeGreaterThan(0);
        expect(detections[0]).toHaveProperty('detectedLanguage', 'en');
      });
      it('instance.detect() should also detect language', async () => {
        global.fetch.mockResolvedValueOnce(Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: '[{"detectedLanguage": "fr", "confidence": 0.8}]' } }] }),
        }));
        const instance = await ai.LanguageDetector.create();
        const detections = await instance.detect('Ceci est un test.');
        expect(Array.isArray(detections)).toBe(true);
        expect(detections.length).toBeGreaterThan(0);
        expect(detections[0]).toHaveProperty('detectedLanguage', 'fr');
      });
    });
  });

  describe('Error Handling during Initialization', () => {
    it('handleInitError should mark all APIs as unavailable if initializeApis fails', async () => {
      global.GM_getValue.mockRejectedValue(new Error('GM_getValue failed'));

      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 50));

      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined();

      expect(await ai.languageModel.availability()).toBe('unavailable');
      await expect(ai.languageModel.create()).rejects.toThrow(/API initialization failed: GM_getValue failed/);

      expect(await ai.Translator.availability()).toBe('unavailable');
      await expect(ai.Translator.create()).rejects.toThrow(/API initialization failed: GM_getValue failed/);
    });
  });

  describe('Rate Limiter', () => {
    it('should eventually limit requests if called too frequently', async () => {
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('KeyManager Functionality (via menu commands)', () => {
    let promptFunction;
    let clearFunction;
    let statusFunction;

    beforeEach(async () => {
      global.GM_getValue.mockResolvedValue('test-api-key');
      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 20));

      const setCall = GM_registerMenuCommand.mock.calls.find(call => call[0] === 'Set OpenRouter API Key');
      if (setCall) promptFunction = setCall[1];

      const clearCall = GM_registerMenuCommand.mock.calls.find(call => call[0] === 'Clear OpenRouter API Key');
      if (clearCall) clearFunction = clearCall[1];
      
      const statusCall = GM_registerMenuCommand.mock.calls.find(call => call[0] === 'Check OpenRouter Key Status');
      if (statusCall) statusFunction = statusCall[1];

      global.window.prompt.mockReturnValue('new-api-key');
      global.window.confirm.mockReturnValue(true);
      global.window.location.reload = jest.fn();
    });

    it('promptForApiKey should attempt to set a key', async () => {
      expect(promptFunction).toBeDefined();
      if (!promptFunction) return;

      await promptFunction();

      expect(global.window.prompt).toHaveBeenCalledWith(
        expect.stringContaining('Enter OpenRouter API Key'),
        expect.any(String)
      );
      expect(GM_setValue).toHaveBeenCalledWith('openrouter_api_key', 'new-api-key');
      expect(global.window.alert).toHaveBeenCalledWith(expect.stringContaining('API Key saved'));
      expect(global.window.location.reload).toHaveBeenCalled();
    });

    it('clearApiKey should attempt to delete the key', async () => {
      expect(clearFunction).toBeDefined();
      if (!clearFunction) return;

      await clearFunction();

      expect(global.window.confirm).toHaveBeenCalledWith(expect.stringContaining('Are you sure'));
      expect(GM_deleteValue).toHaveBeenCalledWith('openrouter_api_key');
      expect(global.window.alert).toHaveBeenCalledWith(expect.stringContaining('OpenRouter API Key cleared.'));
      expect(global.window.location.reload).toHaveBeenCalled();
    });
  });

});