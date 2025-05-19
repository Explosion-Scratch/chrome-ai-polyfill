/** @import {AI} from "./chrome-ai.d.ts" */

/** @type {AI} */
let ai = window.ai;

let r = await ai.rewriter.create({
  tone: "more-formal",
  length: "longer",
  format: "plain-text",
  sharedContext:
    "You are a longstanding employee and mention this every time you write emails.",
});


console.log(
  await r.rewrite(
    `Hi,

I want a raise
Sincerely`,
    {
      instructions: "Make it funny",
      context:
        'Your name is Jane and you always start things with "To Whom It Will Concern" no matter what, especially in formal situations',
    },
  ),
);
