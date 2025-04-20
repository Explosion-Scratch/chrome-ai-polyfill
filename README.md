# Chrome AI APIs Emulator

[![Install with Tampermonkey](https://img.shields.io/badge/Install%20with-Tampermonkey-00485B.svg)](https://github.com/Explosion-Scratch/chrome-ai-polyfill/raw/main/chrome-ai.user.js)
[![OpenRouter](https://img.shields.io/badge/Powered%20by-OpenRouter-5568FF.svg)](https://openrouter.ai/)

## 🚀 Unlock Chrome's Experimental AI APIs Today!

Access Chrome's powerful experimental AI features on **any website** and **any browser** without waiting for official rollout! This userscript emulates Chrome's experimental AI APIs using OpenRouter, enabling you to use these cutting-edge capabilities everywhere.

**What makes this special?** Unlike other implementations, this emulation closely mirrors Chrome's actual API interfaces and behavior, allowing developers to build applications that will work seamlessly when Chrome's native AI APIs become widely available.

![Chrome AI APIs Banner](https://i.imgur.com/example.png)

## 🧠 Supported AI APIs

This emulator provides access to all of Chrome's experimental AI APIs:

### 🔮 `window.ai.languageModel` (Prompt API)
- Create powerful conversational AI interactions
- Customize with system prompts, temperature, and top-k settings
- Full streaming support for responsive interfaces
- Token counting capabilities

### 📝 `window.ai.writer` & `window.ai.rewriter`
- Generate high-quality text based on your prompts
- Rewrite content with specific instructions
- Control output tone and length
- Context-aware writing assistance

### 📋 `window.ai.summarizer`
- Create concise summaries of long content
- Adjust summary type, format, and length
- Add context for more relevant summaries

### 🌐 `window.ai.translator` & `window.ai.languageDetector`
- Translate text between languages
- Auto-detect source languages
- Get confidence scores for language detection

## 🔧 Installation & Setup

1. Install [Tampermonkey](https://www.tampermonkey.net/) or another userscript manager
2. [Click here to install the script](https://github.com/Explosion-Scratch/chrome-ai-polyfill/raw/main/chrome-ai.user.js)
3. Get a free API key from [OpenRouter](https://openrouter.ai/keys)
4. Click the Tampermonkey icon → "Chrome AI APIs Emulator" → "Set OpenRouter API Key"
5. That's it! The APIs are now available via `window.ai`

## 💡 Usage Examples

### Basic Language Model Usage

```javascript
// Create a language model instance
const languageModel = await window.ai.languageModel.create({
  systemPrompt: "You are a helpful assistant who speaks in a pirate accent.",
  temperature: 0.7
});

// Simple prompt
const response = await languageModel.prompt("Tell me about quantum computing");
console.log(response);

// With streaming
const stream = languageModel.promptStreaming("Write a short poem about AI");
for await (const chunk of stream) {
  console.log(chunk); // Process each chunk as it arrives
}
```

### Using the Writer API

```javascript
// Create a writer instance
const writer = await window.ai.writer.create({
  tone: "professional",
  length: "medium"
});

// Generate content
const content = await writer.write("Write a product description for a smart water bottle");
console.log(content);

// With streaming and context
const stream = writer.writeStreaming("Write a follow-up email", {
  context: "Previous email discussed pricing options for enterprise clients."
});
```

### Using the Translator API

```javascript
// Create a translator
const translator = await window.ai.translator.create({
  sourceLanguage: "en",
  targetLanguage: "es"
});

// Translate text
const translation = await translator.translate("Hello world, how are you today?");
console.log(translation);
```

### Using the Summarizer API

```javascript
// Create a summarizer
const summarizer = await window.ai.summarizer.create({
  type: "key-points",
  format: "markdown",
  length: "short"
});

// Summarize content
const longText = "...very long article text here...";
const summary = await summarizer.summarize(longText);
console.log(summary);
```

## 🛠️ Advanced Configuration

### API Options & Parameters

#### Language Model

```javascript
// Session-level configuration
const model = await window.ai.languageModel.create({
  systemPrompt: "You are a helpful assistant.",
  temperature: 0.7,        // 0.0 to 1.0 (deterministic to creative)
  topK: 40,                // Controls diversity
  initialPrompts: [        // Pre-load conversation history
    { role: "user", content: "Tell me about yourself" },
    { role: "assistant", content: "I'm an AI assistant." }
  ]
});

// Per-call options
const response = await model.prompt("What's the weather?", {
  systemPrompt: "You are a weather forecaster.",  // Override for this call only
  temperature: 0.3,                               // More deterministic for this call
  topK: 10                                        // Less diversity for this call
});
```

#### Summarizer

```javascript
const summarizer = await window.ai.summarizer.create({
  type: "key-points",      // "key-points", "paragraph", "tldr", etc.
  format: "markdown",      // "text", "markdown", "html", etc.
  length: "medium",        // "short", "medium", "long"
  sharedContext: "This is scientific research"  // Domain context
});
```

#### Translator

```javascript
// Check translation capability
const available = await window.ai.translator.languagePairAvailable({
  sourceLanguage: "ja",
  targetLanguage: "en"
});

if (available === "available") {
  const translator = await window.ai.translator.create({
    sourceLanguage: "ja",  // BCP-47 language code
    targetLanguage: "en"   // BCP-47 language code
  });
}
```

### API Capabilities

You can check API capabilities before using them:

```javascript
// Check if an API is available
const availability = await window.ai.languageModel.availability();
// Returns: "available", "downloadable", or "unavailable"

// Check detailed capabilities
const capabilities = await window.ai.languageModel.capabilities();
// Returns object with properties like defaultTemperature, maxTemperature, etc.

// For translator
const translatorCapabilities = await window.ai.translator.capabilities();
// Access specific translator capabilities like languagePairAvailable
```

## 🔍 Demo Sites

Experience these APIs in action at these demo sites:

### Community-Built Demos

- [Chrome AI Playground](https://chromeaiplayground.vercel.app) - Test all APIs interactively
- [AI Zaps](https://ai.zaps.dev/) - Creative AI experiments and demos

### Official Chrome Demo Sites

- [Prompt API Playground](https://chrome.dev/web-ai-demos/prompt-api-playground/) - Test the language model
- [Translation & Language Detection](https://chrome.dev/web-ai-demos/translation-language-detection-api-playground/) - Try translation features
- [Summarization API Playground](https://chrome.dev/web-ai-demos/summarization-api-playground/) - Test summarization
- [Writer & Rewriter API](https://chrome.dev/web-ai-demos/writer-rewriter-api-playground/) - Generate and transform text
- [Built-in AI Playground](https://chrome.dev/web-ai-demos/built-in-ai-playground/) - All APIs in one place
- [Summary of Summaries](https://chrome.dev/web-ai-demos/summary-of-summaries/) - Advanced summarization example
- [Weather with AI](https://chrome.dev/web-ai-demos/prompt-api-weather/) - Practical AI application

## 🌟 Why Use This Emulator?

### For Developers

- **Future-Proof Your Apps**: Build with Chrome's AI API interfaces today
- **Cross-Browser Support**: Works on Firefox, Safari, and other browsers
- **No Waiting for Chrome Canary**: Access these features in stable Chrome
- **Privacy Control**: Uses your own API key and custom model selection

### For AI Enthusiasts

- **Experiment with Chrome's AI Vision**: Try what's coming to Chrome
- **Access Premium Models**: Use advanced models via OpenRouter
- **No Special Browser Required**: Works anywhere Tampermonkey runs

## 🔒 Privacy and Security

- Your OpenRouter API key is stored locally via Tampermonkey's secure storage
- All requests go directly from your browser to OpenRouter
- No tracking or analytics included

---

<p align="center">Made with ❤️ for the AI and web developer community</p>
