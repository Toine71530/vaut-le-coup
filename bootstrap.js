// Compatibility bootstrap: the live Gemini endpoint changed after the previous wrapper was written.
// Rewrite the legacy model name before ui-wrapper.js calls fetch, without touching the API key.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === "string") {
    input = input.replace("/models/gemini-2.5-flash:", "/models/gemini-3.6-flash:");
  } else if (input instanceof Request) {
    input = new Request(
      input.url.replace("/models/gemini-2.5-flash:", "/models/gemini-3.6-flash:"),
      input
    );
  }
  return nativeFetch(input, init);
};

await import("./ui-wrapper.js");
