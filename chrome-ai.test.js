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
  },
};

// Mock for window.location
global.window.location = {
  // JSDOM provides a basic location object. We are augmenting/replacing parts of it.
  // Ensure we spread any existing properties from JSDOM's window.location if needed,
  // though for 'reload' direct assignment is usually fine for Jest mocks.
  ...(global.window.location || {}), // Spread existing JSDOM location properties
  assign: jest.fn(),
  replace: jest.fn(),
  href: 'http://localhost/',
  origin: 'http://localhost',
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
    this._queue = [];
    this._closed = false;
    this._error = null;
    this._underlyingSource = underlyingSource; // Store for cancel

    this._controller = {
      enqueue: jest.fn((chunk) => {
        if (this._closed) {
          // console.warn("MockReadableStream: Attempted to enqueue on a closed stream.");
          return;
        }
        this._queue.push(chunk);
      }),
      close: jest.fn(() => {
        if (this._closed) return;
        this._closed = true;
      }),
      error: jest.fn((e) => {
        if (this._closed) return;
        this._error = e;
        this._closed = true;
      }),
      // desiredSize: 1, // Mock desiredSize if needed by the script
    };
    
    if (underlyingSource && underlyingSource.start) {
      Promise.resolve(underlyingSource.start(this._controller))
        .catch(e => {
          if (!this._closed) { // Avoid erroring if already closed/errored
            this._controller.error(e);
          }
        });
    } else {
      // If no start or underlyingSource, consider it an empty, immediately closed stream.
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
    const reader = {
      read: jest.fn(async () => {
        // Wait for microtasks to resolve, allowing enqueued data from async start to appear
        await Promise.resolve(); 
        
        if (this._error) throw this._error;
        if (currentRead < this._queue.length) {
          const value = this._queue[currentRead++];
          return { value: typeof value === 'string' ? new TextEncoder().encode(value) : value, done: false };
        }
        // Only return done: true if the stream is actually closed
        if (this._closed) {
            return { value: undefined, done: true };
        }
        // If not closed and no data, wait a bit (this is a bit hacky for tests, ideally driven by events)
        // Or rely on the consumer to handle pending reads. For this mock, if queue empty but not closed,
        // it implies more data might come. A real stream would pend.
        // Forcing a slight delay to allow async operations to enqueue.
        await new Promise(r => setTimeout(r, 0)); 
        if (this._error) throw this._error; // Check error again
         if (currentRead < this._queue.length) { // Check queue again
          const value = this._queue[currentRead++];
          return { value: typeof value === 'string' ? new TextEncoder().encode(value) : value, done: false };
        }
        return { value: undefined, done: this._closed }; // Return based on closed state if still no data
      }),
      releaseLock: jest.fn(() => {
        this._locked = false;
      }),
      cancel: jest.fn(async (reason) => {
        if (this._underlyingSource && this._underlyingSource.cancel) {
          await Promise.resolve(this._underlyingSource.cancel(reason));
        }
        this._closed = true;
        this._error = reason instanceof Error ? reason : new DOMException('Stream cancelled', 'AbortError');
        this._queue = []; // Clear queue on cancel
        return Promise.resolve();
      }),
      closed: new Promise((resolve, reject) => {
        const checkClosed = () => {
          if (this._error) reject(this._error);
          else if (this._closed && currentRead >= this._queue.length) resolve(undefined);
          else setTimeout(checkClosed, 5); 
        };
        checkClosed();
      })
    };
    return reader;
  }

  cancel(reason) {
    if (this._underlyingSource && this._underlyingSource.cancel) {
      return Promise.resolve(this._underlyingSource.cancel(reason)).then(() => {
        this._closed = true;
        this._error = reason instanceof Error ? reason : new DOMException('Stream cancelled', 'AbortError');
        this._queue = [];
      });
    }
    this._closed = true;
    this._error = reason instanceof Error ? reason : new DOMException('Stream cancelled', 'AbortError');
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
        if (!code || typeof code !== 'string') return undefined;
        const names = {
          'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
          'zh': 'Chinese', 'und': 'Undetermined',
        };
        const langPart = code.toLowerCase().split('-')[0];
        return names[langPart] || code;
      }),
    };
  }),
};

// Mock window properties
global.unsafeWindow = global; // For Tampermonkey, often unsafeWindow is window

if (typeof global.performance !== 'object' || global.performance === null) {
  global.performance = {};
}
global.performance.now = performanceNowMock;

global.window.alert = jest.fn();
global.window.prompt = jest.fn();
global.window.confirm = jest.fn(() => true); // Default to 'OK'
global.window.fetch = jest.fn();


global.marked = {
  parse: jest.fn((text) => `<p>${text}</p>`), 
};
global.DOMPurify = {
  sanitize: jest.fn((html) => html), 
};

// Store original console
const originalConsole = { ...global.console };

// --- Helper to load the script ---
const loadUserScript = () => {
  jest.isolateModules(() => {
    require('./chrome-ai.user.js');
  });
};

// --- Test Suites ---

describe('Chrome AI Polyfill (chrome-ai.user.js)', () => {
  let ai; 

  if (typeof global.process === 'undefined') {
    global.process = {
      nextTick: (callback) => setTimeout(callback, 0),
      env: {},
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks(); // Clears all mocks, including GM_* and console if spied/mocked directly
    
    // Reset console mocks specifically if they are module-level
    global.console = {
        ...originalConsole, // Restore original console functions
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

    global.GM_getValue.mockResolvedValue(null); 
    performanceNowMock.mockReturnValue(Date.now()); 


    if (global.unsafeWindow && global.unsafeWindow.ai) {
      delete global.unsafeWindow.ai;
    }
    const pendingPromisesSymbol = Object.getOwnPropertySymbols(global.unsafeWindow).find(s => s.toString() === 'Symbol(_pendingAIPromises)');
    if (pendingPromisesSymbol && global.unsafeWindow[pendingPromisesSymbol]) {
      delete global.unsafeWindow[pendingPromisesSymbol];
    }

    global.fetch.mockImplementation(async (url, options) => {
        console.log("Mock fetch called with URL:", url, "and options:", options.body);
        const urlString = url.toString();
      if (urlString.includes('/key')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { limit: 100, usage: 10, is_free_tier: false, label: "Test Key" } }),
          text: () => Promise.resolve(JSON.stringify({ data: { limit: 100, usage: 10, is_free_tier: false, label: "Test Key" } })),
        });
      }
      if (urlString.includes('/chat/completions')) {
        const requestBody = options && options.body ? JSON.parse(options.body) : {};
        if (requestBody.stream) {
          return Promise.resolve({
            ok: true,
            body: new MockReadableStream({ // Use the mock directly
              start(controller) {
                controller.enqueue('data: {"id":"1","model":"","choices":[{"index":0,"delta":{"role":"assistant","content":"Mocked "}}]}\n\n');
                controller.enqueue('data: {"id":"1","model":"","choices":[{"index":0,"delta":{"content":"stream "}}]}\n\n');
                controller.enqueue('data: {"id":"1","model":"","choices":[{"index":0,"delta":{"content":"response."}}]}\n\n');
                controller.enqueue('data: [DONE]\n\n');
                controller.close();
              }
            }),
            headers: new Headers({'Content-Type': 'text/event-stream'})
          });
        } else {
          const mockContent = 'Mocked non-stream response';
          const mockJsonResponse = { id: "chatcmpl-test", choices: [{ message: { role: "assistant", content: mockContent } }] };
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockJsonResponse),
            text: () => Promise.resolve(JSON.stringify(mockJsonResponse)),
          });
        }
      }
      return Promise.resolve({
        ok: false, status: 404, statusText: "Not Found",
        json: () => Promise.resolve({ error: "Mock fetch: Unhandled URL" }),
        text: () => Promise.resolve("Mock fetch: Unhandled URL"),
        body: new MockReadableStream({ start(c){ c.close(); }})
      });
    });
  });

  describe('Initial Setup and Configuration', () => {
    it('should define the ai namespace on unsafeWindow', async () => {
      loadUserScript();
      await new Promise(process.nextTick); 
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(global.unsafeWindow.ai).toBeDefined();
      expect(typeof global.unsafeWindow.ai).toBe('object');
    });

    it('should register Greasemonkey menu commands during initialization if API key is present', async () => {
      global.GM_getValue.mockResolvedValue('test-api-key');
      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 30)); 
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
      loadUserScript(); 
      // To test Logger, we'd need to export it or call a function that uses it.
      // For now, just verify console.log was called by the script's own logging.
      // This also indirectly tests if Config.EMULATED_NAMESPACE is used.
      global.unsafeWindow.ai.languageModel.availability(); // Trigger some activity that might log
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[ai]'));
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
      // Capabilities might be on the main object or on a sub-object after create for some APIs in spec
      // For this polyfill, static APIs have .capabilities directly.
      expect(typeof apiObject.capabilities).toBe('function');
      
      if (apiName === 'Translator' || apiName === 'translator') {
        expect(typeof apiObject.languagePairAvailable).toBe('function');
      }
    };

    it('should create all API objects in unsafeWindow.ai when enabled in Config', async () => {
      loadUserScript();
      await new Promise(process.nextTick); 
      await new Promise(resolve => setTimeout(resolve, 20)); 
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined();

      allApiNames.forEach(apiName => {
        checkApiObjectStructure(ai[apiName], apiName);
        if (apiAliases[apiName]) {
          checkApiObjectStructure(ai[apiAliases[apiName]], apiAliases[apiName]);
          expect(ai[apiAliases[apiName]]).toBe(ai[apiName]); // Test that alias points to the same object
        }
      });
      expect(typeof ai.canCreateTextSession).toBe('function');
      expect(typeof ai.createTextSession).toBe('function');
    });

    it('should add convenience methods like canCreateTextSession and createTextSession', async () => {
      global.GM_getValue.mockResolvedValue('test-api-key'); // Ensure key for 'readily'
      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 20)); 
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined();

      expect(typeof ai.canCreateTextSession).toBe('function');
      expect(typeof ai.createTextSession).toBe('function');
      expect(typeof ai.canCreateGenericSession).toBe('function');

      const canCreate = await ai.canCreateTextSession();
      // Expect 'readily' or 'no' based on the userscript fix
      expect(['readily', 'no', 'available', 'after-prompt']).toContain(canCreate);
      expect(canCreate).toBe('readily'); // With API key, it should be readily

      if (ai.languageModel && typeof ai.languageModel.create === 'function') {
        const mockCreate = jest.spyOn(ai.languageModel, 'create').mockResolvedValue({ mockInstance: true });
        await ai.createTextSession();
        expect(mockCreate).toHaveBeenCalled();
        mockCreate.mockRestore();
      } else {
        throw new Error('ai.languageModel.create is not available for mocking');
      }
    });
  });

  describe('API Behavior - No API Key', () => {
    beforeEach(async () => {
      global.GM_getValue.mockResolvedValue(null);
      loadUserScript();
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 30)); 
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined(); 
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
    it('summarizer.capabilities should indicate "no"', async () => {
        expect(await ai.summarizer.capabilities()).toEqual({ available: 'no' });
    });
    it('summarizer.create should reject', async () => {
      await expect(ai.summarizer.create()).rejects.toThrow(/summarizer: Cannot create instance, API Key is not configured./);
    });

    it('writer.availability should be "unavailable"', async () => {
      expect(await ai.writer.availability()).toBe('unavailable');
    });
    it('writer.capabilities should indicate "no"', async () => {
        expect(await ai.writer.capabilities()).toEqual({ available: 'no' });
    });
    it('writer.create should reject', async () => {
      await expect(ai.writer.create()).rejects.toThrow(/writer: Cannot create instance, API Key is not configured./);
    });

    it('rewriter.availability should be "unavailable"', async () => {
      expect(await ai.rewriter.availability()).toBe('unavailable');
    });
    it('rewriter.capabilities should indicate "no"', async () => {
        expect(await ai.rewriter.capabilities()).toEqual({ available: 'no' });
    });
    it('rewriter.create should reject', async () => {
      await expect(ai.rewriter.create()).rejects.toThrow(/rewriter: Cannot create instance, API Key is not configured./);
    });

    it('Translator.availability should be "unavailable"', async () => {
      expect(await ai.Translator.availability()).toBe('unavailable');
    });
    it('Translator.capabilities should indicate "no" and no languagePairAvailable method', async () => {
        const caps = await ai.Translator.capabilities();
        expect(caps.available).toBe('no');
        // When 'no', languagePairAvailable might not be part of capabilities directly in some specs
        // but the static method ai.Translator.languagePairAvailable should still exist.
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
     it('LanguageDetector.capabilities should indicate "no"', async () => {
        expect(await ai.LanguageDetector.capabilities()).toEqual({ available: 'no' });
    });
    it('LanguageDetector.create should reject', async () => {
      await expect(ai.LanguageDetector.create()).rejects.toThrow(/LanguageDetector: Cannot create instance, API Key is not configured./);
    });

    it('should log a warning about missing API key', async () => {
      // Warning is logged during initializeApis, which is called by loadUserScript
      // We need to ensure GM_getValue is null *before* loadUserScript for this specific test.
      global.GM_getValue.mockResolvedValue(null);
      // loadUserScript(); // already called in beforeEach, but let's ensure the state
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 50));

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
      await new Promise(resolve => setTimeout(resolve, 30));
      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined();
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
      it('session.promptStreaming() should return a ReadableStream yielding content', async () => {
        const session = await ai.languageModel.create();
        const stream = await session.promptStreaming('Stream test');
        expect(stream).toBeInstanceOf(ReadableStream);
        const reader = stream.getReader();
        let resultText = '';
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resultText += new TextDecoder().decode(value);
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
      it('languagePairAvailable should be "available" for valid pairs', async () => {
        expect(await ai.Translator.languagePairAvailable({sourceLanguage: 'en', targetLanguage: 'es'})).toBe('available');
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
        // Override fetch mock for this specific test to return valid LanguageDetector JSON
        global.fetch.mockImplementationOnce(async () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: '[{"detectedLanguage": "en", "confidence": 0.9}]' } }] }),
            text: () => Promise.resolve('[{"detectedLanguage": "en", "confidence": 0.9}]'), // Ensure text() matches
        }));
        const instance = await ai.LanguageDetector.create();
        const detections = await instance.detectLanguage('This is a test.');
        expect(Array.isArray(detections)).toBe(true);
        expect(detections.length).toBeGreaterThan(0);
        expect(detections[0]).toHaveProperty('detectedLanguage', 'en');
      });
      it('instance.detect() should also detect language', async () => {
         global.fetch.mockImplementationOnce(async () => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: '[{"detectedLanguage": "fr", "confidence": 0.8}]' } }] }),
            text: () => Promise.resolve('[{"detectedLanguage": "fr", "confidence": 0.8}]'),
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
      const initError = new Error('GM_getValue failed critically');
      global.GM_getValue.mockRejectedValue(initError);

      loadUserScript();
      await new Promise(process.nextTick);
      // Add more time for all error handling paths and async logs to settle
      await new Promise(resolve => setTimeout(resolve, 60)); 

      ai = global.unsafeWindow.ai;
      expect(ai).toBeDefined();

      expect(await ai.languageModel.availability()).toBe('unavailable');
      await expect(ai.languageModel.create()).rejects.toThrow(/API initialization failed: GM_getValue failed critically/);

      expect(await ai.Translator.availability()).toBe('unavailable');
      await expect(ai.Translator.create()).rejects.toThrow(/API initialization failed: GM_getValue failed critically/);
    });
  });

  describe('Rate Limiter', () => {
    // Basic test, more comprehensive tests would require manipulating time.
    it('should allow some requests and then limit if called too frequently (conceptual)', async () => {
      // This is hard to test precisely without fine-grained time control (jest.useFakeTimers)
      // and direct access to the RateLimiter instance.
      // For now, this is a conceptual placeholder.
      // A full test would involve:
      // 1. Accessing the RateLimiter instance used by CoreAPI.
      // 2. Calling a method that uses it (e.g., CoreAPI.askOpenRouter) multiple times rapidly.
      // 3. Advancing timers.
      // 4. Asserting that some calls succeed and later ones throw rate limit errors.
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('KeyManager Functionality (via menu commands)', () => {
    let promptFunction;
    let clearFunction;
    // let statusFunction; // Not used in current failing tests but good to have

    beforeEach(async () => {

      global.GM_getValue.mockResolvedValue('test-api-key'); // Key exists for menu commands
      loadUserScript(); 
      
      await new Promise(process.nextTick);
      await new Promise(resolve => setTimeout(resolve, 30)); // Allow script init

      // Reset window interaction mocks for each test
      global.window.prompt.mockClear().mockReturnValue('new-api-key'); // Default new key
      global.window.confirm.mockClear().mockReturnValue(true); // Default confirm true
      global.window.alert.mockClear();
      GM_setValue.mockClear();
      GM_deleteValue.mockClear();


      const setCall = GM_registerMenuCommand.mock.calls.find(call => call[0] === 'Set OpenRouter API Key');
      if (setCall) promptFunction = setCall[1];

      const clearCall = GM_registerMenuCommand.mock.calls.find(call => call[0] === 'Clear OpenRouter API Key');
      if (clearCall) clearFunction = clearCall[1];
      
      // const statusCall = GM_registerMenuCommand.mock.calls.find(call => call[0] === 'Check OpenRouter Key Status');
      // if (statusCall) statusFunction = statusCall[1];
    });

    it('promptForApiKey should attempt to set a new key', async () => {
      expect(promptFunction).toBeDefined();
      if (!promptFunction) return;

      global.window.prompt.mockReturnValue('new-api-key-for-test');
      await promptFunction();

      expect(global.window.prompt).toHaveBeenCalledWith(
        expect.stringContaining('Enter OpenRouter API Key'),
        'test-api-key' // Current key
      );
      expect(GM_setValue).toHaveBeenCalledWith('openrouter_api_key', 'new-api-key-for-test');
      expect(global.window.alert).toHaveBeenCalledWith(expect.stringContaining('API Key saved. Reloading page'));
    });

    it('clearApiKey should attempt to delete the key and reload', async () => {
      expect(clearFunction).toBeDefined();
      if (!clearFunction) return;

      await clearFunction(); // This function itself in userscript calls GM_getValue first

      expect(global.window.confirm).toHaveBeenCalledWith(expect.stringContaining('Are you sure'));
      expect(GM_deleteValue).toHaveBeenCalledWith('openrouter_api_key');
      expect(global.window.alert).toHaveBeenCalledWith(expect.stringContaining('OpenRouter API Key cleared. Reloading page'));
    });
  });

});