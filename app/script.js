/**
 * Copyright 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const form = document.querySelector("form");
const input = document.querySelector("input");
const output = document.querySelector("output");
const pre = document.querySelector("pre");

const getPrompt = (word) =>
  `Suggest a list of unique synonyms for the word "${word}".`;

(async () => {
  let isAvailable = false;

  // The Prompt API currently has a different shape in Chrome stable and canary, with the flags
  // enabled. In Chrome stable, the namespace for the API is `ai.languageModel` and the method
  // to check for availability is `ai.languageModel.capabilities()`, and the method returns a
  // capabilities object that contains a field `available`, which the values can be `yes`,
  // `no`, and `after-download`. In the new API shape, the namespace is just `LanguageModel`,
  // and the availability can be verified with the `availability` method, which returns
  // `available`, `unavailable` or `downloadable`. the implementation below covers both
  // scenarios.
  if ("LanguageModel" in self) {
    const availability = await LanguageModel.availability();
    console.log(availability);
    if (availability !== "unavailable") {
      isAvailable = true;
    }
  } else if ("ai" in self && "languageModel" in ai) {
    const capabilities = await ai.languageModel.capabilities();
    console.log(capabilities);
    if (capabilities.available !== "no") {
      isAvailable = true;
    }
  }

  console.log(isAvailable);

  if (!isAvailable) {
    document.querySelector("div").hidden = false;
    return;
  }

  document.querySelector("main").hidden = false;
  const createOptions = {
    initialPrompts: [
      {
        role: "system",
        content: `You act as a thesaurus assistant that responds with synonyms of an input word.
Only respond with the list of synonyms.
Do not respond with further additional text before or after the list.
Each synonym may only occur once in the list. Respond with one synonym per line.`,
      },
      {
        role: "user",
        content: 'Suggest a list of unique synonyms for the word "funny".',
      },
      {
        role: "assistant",
        content: `- amusing
- humorous
- comic
- comical
- droll
- laughable
- chucklesome
- hilarious
- hysterical
- riotous
- uproarious
- witty
- quick-witted
- waggish
- facetious
- jolly
- jocular
- lighthearted
- entertaining
- diverting
`,
      },
    ],
  };

  // Creates the model using either the new API shape available in Canary or the previous shape
  // available in Chrome stable.
  const languageModel =
    "LanguageModel" in self
      ? await LanguageModel.create(createOptions)
      : await ai.languageModel.create(createOptions);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const word = input.value
      .trim()
      .split(/\s+/)[0]
      .replace(/[^a-zA-Z\n]/g, "");
    if (!word) {
      return;
    }
    const prompt = getPrompt(word);
    try {
      const assistantClone = await languageModel.clone();
      const stream = assistantClone.promptStreaming(prompt);
      output.innerHTML = "";
      pre.innerHTML = "";
      const doc = document.implementation.createHTMLDocument();
      doc.write(
        `<div>Here's a list of synonyms for the word <span>${word}</span>:<ul><li>`,
      );
      output.append(doc.body.firstChild);

      for await (const chunk of stream) {
        pre.insertAdjacentText("beforeEnd", chunk);
        const newContent = chunk
          .replace(/^\s*[\-\*]\s*/, "")
          .replace(/[^a-zA-Z\n]/g, "")
          .replace("\n", "<li>");
        doc.write(newContent);
      }
      doc.write("</ul></div>");
    } catch (error) {
      console.log(error.name, error.message);
      output.innerHTML = `<pre>${error.name}: ${error.message}</pre>`;
    }
  });
})();
