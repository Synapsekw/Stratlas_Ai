# Set up a local model

The agent can run on a language model on this computer instead of a cloud provider. Nothing leaves this computer, there is no cost, and it works with cloud AI off and in projects that forbid cloud AI.

No model comes with {product}. Install one of these free servers yourself, then download a model with tool calling. A model that also has vision can look at photos.

## Install a server

Pick one:

- **Ollama**: install it from ollama.com, then download a model marked "tools" in its library with `ollama pull` and the model name. It listens on port 11434.
- **LM Studio**: install it from lmstudio.ai, download a model with tool use in its Discover tab, then start the server in its Developer tab. It listens on port 1234.
- **llama.cpp server**: start `llama-server` with a GGUF model and the `--jinja` option, which tool calling needs. It listens on port 8080.

You install the model, so its licence terms apply to you. Check them before you use it for work.

## Connect it

1. Open **Settings**, **AI providers** and find **Local model**.
2. Switch on **Use a local model**.
3. Check the **Address**, for example `http://localhost:11434/v1` for Ollama.
4. Click **Find models**. {product} looks on this computer and lists what the server has, for example "Ollama at http://localhost:11434: 3 models". Badges show **Tools**, **Vision** and the context size.
5. Click a model in the list. It is marked **In use**. You can also type its name in **Model**.
6. Click **Test**. It reads, for example, "Tools yes, vision no. First answer in 4 s."

If the model has no tool calling, the test says "This model cannot call tools: the agent will answer in text only." The agent then answers questions but cannot move the camera or change anything.

## Run every task offline

Switch on **Offline agent**. It routes agent chat, vision, report writing, extraction and building from drawings to the local model in one step: "Every task runs on ... Nothing leaves this machine." Switch it off to go back to the routes you had before.

To route only some tasks to the local model, pick **Local model** for them in **Model routing** (see [Which model does what](07-ai-agent.md#which-model-does-what)).

While the agent runs on the local model, its status line reads "Agent: local (offline) · ... on this machine". Nothing asks you to preview a send, and the cost stays at 0.

A model without tool calling shows a notice in the agent panel: "This local model cannot use the app's tools, so the agent answers in text only." Choose a model with tool calling to let it act.

## Settings for slower computers

- **Tool list**: **Full**, or **Compact** for a small model. Compact offers fewer tools with short descriptions. Choose it for a model with a small context window.
- **Wait for the first answer**: **1 min** to **10 min**. A model may need time to load, most of all on a computer without a graphics card.

Small models answer more slowly and make more mistakes than cloud models. Without a graphics card an answer can take tens of seconds. **Stop** in the agent panel stops a slow answer.

## A server key

Only for a server that asks for one, such as LM Studio or a secured llama.cpp server: paste the key in **Server key** and click **Save key**. It reads **Key stored**. The key goes to the system vault, never into the settings file. **Replace key** changes it.

## A server on another machine

An address that is not on this computer, for example a server elsewhere on your network, is not local: requests to it leave this computer, so they count as cloud AI. **Find models** warns first; **Look there anyway** goes on, **Cancel** stops. With cloud AI off, {product} does not send to it.

## If it does not answer

- "Cannot reach the local model server at ...": start Ollama, LM Studio or the llama.cpp server, or check the **Address**.
- The first answer takes long: the model is loading. Wait, or set a longer **Wait for the first answer**.
- The agent answers but does nothing: the model has no tool calling. Pick another model and click **Test** again.
- The agent cannot read photos: the model has no vision. Choose a model with vision for **Photo and frame vision** in **Model routing**.
