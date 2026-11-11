// The instructions behind the ? on each section of Settings: how to get a key for each provider,
// and what the agent settings do. HTML, shown in a panel inside the section.
// Checked against the providers' documentation on 2026-11-11.

const link = (url, text = url.replace(/^https:\/\//, "")) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
const origin = () => location.origin;

export const HELP = {
  claude: `
    <p>Claude models through Anthropic's API, paid per use from prepaid credit. This is separate from a
      claude.ai chat subscription (though Max, Ultra and Team subscribers can link a Console organization
      and get monthly API credit: claude.ai → Settings → Billing → API credits).</p>
    <ol>
      <li>Sign in or create an account at ${link("https://platform.claude.com")}.</li>
      <li>Add credit: ${link("https://platform.claude.com/settings/billing", "Billing")} → <b>Buy credits</b>.
        New accounts get a little free credit to try the API. Credits expire after a year and are not
        refundable. A typical request here costs well under a cent with Haiku and a few cents with Opus.</li>
      <li>To cap what Slicerdome can spend (recommended), make a workspace for it:
        ${link("https://platform.claude.com/settings/workspaces", "Workspaces")} → <b>Create workspace</b>
        (“Slicerdome”), select it and set <b>Spend limits</b>. The Default Workspace cannot have a limit,
        and keys themselves cannot.</li>
      <li>Create the key: ${link("https://platform.claude.com/settings/keys", "API keys")} → <b>Create key</b>.
        Name it, choose an expiration (30 days is a good choice for a key kept in a browser) and
        <b>choose a workspace</b> (the Slicerdome one, or Default): a key without a workspace is refused.
        Copy it: it starts with <code>sk-ant-</code> and is shown only once.</li>
      <li>Paste it into <b>API key</b> here, press <b>Test key</b>, then <b>Save</b>, and pick Claude Haiku,
        Sonnet or Opus in the menu at the top.</li>
    </ol>
    <p>The page sends requests from your browser straight to <code>api.anthropic.com</code>; the key is
      kept in this browser only. Some organizations cannot be used from a browser at all: those with zero
      data retention or the Compliance API turned on (often institutional accounts linked to Claude
      Enterprise) get “CORS requests are not allowed for this Organization”. A personal account works.</p>
    <p>On our Slicer tasks Haiku was the cheapest and Opus made the fewest mistakes (see <b>Models</b>).</p>`,

  agent: `
    <ul>
      <li><b>Think first</b>: models running in this browser reason before each step. Their answers get
        better, but each step is much slower. Remote models decide for themselves how much to reason.</li>
      <li><b>Max steps</b>: how many replies the model may make for one request; each reply can run tools
        (search, read a file, run Python). 12 is enough for most tasks; weaker models sometimes need
        more to recover from their mistakes, which costs more and takes longer.</li>
      <li><b>Cost limit</b>: a request stops before running more tools once it has cost this much
        (Claude and OpenRouter report their cost). The toolbar shows what this tab has spent.</li>
      <li><b>Help</b>: for weaker models the page adds examples from Slicer's script repository to the
        request, searches error messages for fixes and stops the model when it repeats failing code.
        It is on for models in the browser; “for all models” also gives it to remote models (more input,
        so a little more cost).</li>
    </ul>`,

  openrouter: `
    <p>One key for hundreds of models from many makers (Qwen, DeepSeek, Kimi, GLM, Gemini, GPT, Claude, …),
      paid per use from prepaid credit. Use <b>Models</b> in the toolbar to find one.</p>
    <ol>
      <li>Create an account or sign in at ${link("https://openrouter.ai")}.</li>
      <li>Add credit: ${link("https://openrouter.ai/settings/credits")}. $10 is plenty to try many models.
        OpenRouter adds a 5.5% fee to purchases and passes on model prices unchanged; unused credit can
        be refunded only within 24 hours and may expire after a year. Leave auto top-up off and your
        balance is a hard cap.</li>
      <li>Create a key: ${link("https://openrouter.ai/settings/keys")} → <b>Create API Key</b>. Give it a
        name, a <b>credit limit</b> (say $5; it can also reset daily, weekly or monthly) and an expiration.
        Copy it: it starts with <code>sk-or-v1-</code>. Copy it right away; it is not shown again.</li>
      <li>Paste it into <b>API key</b> here and <b>Save</b>. Then pick a model with <b>Models</b>, or type its id
        (for example <code>deepseek/deepseek-v4.1-flash</code>) into <b>Model</b>.</li>
    </ol>
    <p>Or press <b>Sign in with OpenRouter</b>: you approve on OpenRouter's site and it gives this page a key
      of its own, paid from your credit. Set a credit limit on it afterwards on the keys page.</p>
    <p>Free models (ids ending in <code>:free</code>) need no credit but allow only 50 requests a day
      (1000 after you have bought $10 of credit), and one question here can take several requests.
      If a model answers “No endpoints found matching your data policy”, your choices at
      ${link("https://openrouter.ai/settings/privacy")} (training opt-outs, zero data retention) rule out
      every provider of that model.</p>`,

  jetstream2: `
    <p>Jetstream2's LLM inference service (Indiana University): open models, free for research and
      education, for anyone with an ACCESS account. No allocation is needed and it uses no SUs.</p>
    <ol>
      <li>If you have no ACCESS account, create one at ${link("https://identity.access-ci.org/new-user")}.</li>
      <li>Go to ${link("https://llm.jetstream-cloud.org")} → <b>Continue with ACCESS single sign-on</b> and
        choose the <b>ACCESS CI (XSEDE)</b> identity provider.</li>
      <li>Click your user name (lower left) → <b>Settings</b> → <b>Account</b> → <b>API keys</b> and create a
        secret key (<b>Show</b> next to Secrets → <b>Create new secret key</b>). Copy it; it starts with
        <code>sk-</code>. Each account has one key: creating a new one cancels the old.</li>
      <li>Here: <b>Base URL</b> <code>https://llm.jetstream-cloud.org/api</code>, <b>API key</b> the key,
        <b>Model</b> one of <code>qwen-3.8-27b</code>, <code>gemma-4-31b-it</code>, <code>muse-glimmer</code>
        (the ones that call tools), <b>Key header</b> Authorization: Bearer. <b>Fetch model list</b> shows
        what is offered now.</li>
    </ol>
    <p>Use this <code>/api</code> address: the service's direct model addresses only answer inside
      Jetstream2's network. Data stays in IU's data center and is not used for training; the service's
      administrators can see conversations to enforce its usage policy
      (${link("https://docs.jetstream-cloud.org/inference-service/overview/", "details")}). It is still
      being built and has short outages
      (${link("https://docs.jetstream-cloud.org/inference-service/status/", "status")}). Qwen3.8 27B passed
      11 of our 23 hard Slicer tasks through another host.</p>`,

  azure: `
    <p>Models deployed in your own Azure subscription with Microsoft Foundry, billed to the subscription
      per token used.</p>
    <ol>
      <li>You need an Azure subscription and a role that can create a Foundry resource (Foundry Owner or
        Foundry Account Owner; institutional subscriptions may need IT to grant it).</li>
      <li>At ${link("https://ai.azure.com")} (with <b>New Foundry</b> on) → <b>Create new project</b>; choose a
        resource group and location under <b>Advanced options</b>. The resource is created with it.</li>
      <li><b>Build → Catalog → Model Catalog</b>: pick a chat model that calls tools → <b>Deploy</b>. Write down
        the <b>deployment name</b> (by default the model's name). Check it shows <b>Succeeded</b> under
        <b>Build → Models</b>.</li>
      <li>Copy the API key from the project's <b>Home</b> page, or in the Azure portal: the resource →
        <b>Keys and Endpoint</b> → KEY1.</li>
      <li>Here: <b>Base URL</b> <code>https://RESOURCE.services.ai.azure.com/openai/v1</code> (or
        <code>https://RESOURCE.openai.azure.com/openai/v1</code>), <b>API key</b> the key, <b>Model</b> the
        <i>deployment name</i>, <b>Key header</b> <code>api-key</code>.</li>
    </ol>
    <p>RESOURCE is your resource's name. The “project endpoint” on the Home page
      (<code>…/api/projects/…</code>) is not the chat address: take the resource name from it. A 404 usually
      means the Base URL does not end in <code>/openai/v1</code>.</p>
    <p>Pay-as-you-go subscriptions have no hard spending cap: budgets only send alerts. Keep a low
      tokens-per-minute limit on the deployment (<b>Custom settings</b> when deploying). The key gives full
      access to the resource. Claude models deployed in Foundry use Anthropic's API format, which this
      section does not support. Calling Azure from a browser is not documented by Microsoft; it worked on
      Microsoft's shared endpoint, but a resource behind a firewall or private endpoint will refuse it.</p>`,

  custom: `
    <p>Any server that speaks OpenAI's chat completions API, including one on your own computer. It must
      allow requests from this page's origin, <code>${origin()}</code> (no path). Chrome asks once for
      permission to reach your computer's local network: press <b>Fetch model list</b> first and allow it.</p>
    <h4>Ollama</h4>
    <ol>
      <li>Install Ollama and pull a model that calls tools (${link("https://ollama.com/search?c=tools", "tools models")}),
        for example <code>ollama pull qwen3</code>.</li>
      <li>Allow this page: on a Mac, <code>launchctl setenv OLLAMA_ORIGINS "${origin()}"</code> and restart
        the Ollama app; or run <code>OLLAMA_ORIGINS=${origin()} ollama serve</code>. On Linux set it in the
        service (<code>systemctl edit ollama.service</code>); on Windows as a user environment variable.</li>
      <li>Here: <b>Base URL</b> <code>http://localhost:11434/v1</code>, any <b>API key</b> (for example
        <code>ollama</code>), <b>Model</b> the tag (<code>qwen3</code>).</li>
    </ol>
    <h4>LM Studio</h4>
    <ol>
      <li><b>Developer</b> tab → <b>Start server</b> (or <code>lms server start --cors</code>), and turn on
        <b>Enable CORS</b> in Server Settings (off by default).</li>
      <li>Here: <b>Base URL</b> <code>http://localhost:1234/v1</code> (or the server port you set),
        <b>Model</b> the identifier LM Studio shows. If you turn on Require Authentication, put its token in
        <b>API key</b>. Models with a hammer badge call tools best.</li>
    </ol>
    <h4>vLLM</h4>
    <ol>
      <li><code>vllm serve MODEL --api-key SECRET --allowed-origins '["${origin()}"]' --enable-auto-tool-choice
        --tool-call-parser PARSER</code> (browser access is off unless you allow the origin; the parser must
        match the model).</li>
      <li>Here: <b>Base URL</b> <code>http://localhost:8000/v1</code>, <b>API key</b> the secret, <b>Model</b>
        the served model name. A wrong key may show up as a network error rather than “unauthorized”.</li>
    </ol>
    <p>Models small enough for a laptop did poorly on our Slicer tasks; see the scores in <b>Models</b>.</p>`,
};
