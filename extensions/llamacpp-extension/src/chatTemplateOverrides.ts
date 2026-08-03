/**
 * @file Load-time chat_template overrides for models whose embedded Jinja
 * template carries a strict guard that breaks llama.cpp's `--jinja` auto-parser.
 *
 * The unsloth conversions of Llama 3.x ship a chat template with a hard guard
 * `{{- raise_exception('System message must be at the beginning') }}`. When the
 * server runs with `--jinja`, the auto-parser feeds the template synthetic
 * message permutations during differential analysis; one of those probes
 * violates the guard, so parser generation aborts with
 * `400 Unable to generate parser for this template`. The canonical Meta Llama
 * 3.x template has no such guard (it softly defaults the system message to "").
 *
 * We detect the strict guard in the embedded template and, only for Llama-3
 * format models, substitute the canonical Meta template via `cfg.chat_template`
 * (-> `--chat-template`). The substitute is the standard Llama 3 tool format the
 * auto-parser already supports.
 */

/** Signature of the strict system-message guard embedded in the bad templates. */
export const STRICT_SYSTEM_GUARD_SIGNATURE =
  'System message must be at the beginning'

/** Matches Llama 3 / 3.x model ids (e.g. `Llama-3_2-3B`, `llama-3.1-8b`). */
const LLAMA3_MODEL_ID_RE = /llama[-_. ]?3(\.\d+)?/i

/** Llama 3 prompt-format marker present in any genuine Llama 3 template. */
const LLAMA3_FORMAT_MARKER = '<|start_header_id|>'

/**
 * Canonical Meta Llama 3.x instruct chat template (covers 3.1/3.2/3.3).
 *
 * Sourced verbatim from
 * `models/templates/meta-llama-Llama-3.2-3B-Instruct.jinja` in the llama.cpp
 * backend repo. `String.raw` preserves the literal `\n` escapes inside the
 * Jinja string literals (minja interprets them, not JS).
 */
export const CANONICAL_LLAMA3_CHAT_TEMPLATE = String.raw`{{- bos_token }}
{%- if custom_tools is defined %}
    {%- set tools = custom_tools %}
{%- endif %}
{%- if not tools_in_user_message is defined %}
    {%- set tools_in_user_message = true %}
{%- endif %}
{%- if not date_string is defined %}
    {%- if strftime_now is defined %}
        {%- set date_string = strftime_now("%d %b %Y") %}
    {%- else %}
        {%- set date_string = "26 Jul 2024" %}
    {%- endif %}
{%- endif %}
{%- if not tools is defined %}
    {%- set tools = none %}
{%- endif %}

{#- This block extracts the system message, so we can slot it into the right place. #}
{%- if messages[0]['role'] == 'system' %}
    {%- set system_message = messages[0]['content']|trim %}
    {%- set messages = messages[1:] %}
{%- else %}
    {%- set system_message = "" %}
{%- endif %}

{#- System message #}
{{- "<|start_header_id|>system<|end_header_id|>\n\n" }}
{%- if tools is not none %}
    {{- "Environment: ipython\n" }}
{%- endif %}
{{- "Cutting Knowledge Date: December 2023\n" }}
{{- "Today Date: " + date_string + "\n\n" }}
{%- if tools is not none and not tools_in_user_message %}
    {{- "You have access to the following functions. To call a function, please respond with JSON for a function call." }}
    {{- 'Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}.' }}
    {{- "Do not use variables.\n\n" }}
    {%- for t in tools %}
        {{- t | tojson(indent=4) }}
        {{- "\n\n" }}
    {%- endfor %}
{%- endif %}
{{- system_message }}
{{- "<|eot_id|>" }}

{#- Custom tools are passed in a user message with some extra guidance #}
{%- if tools_in_user_message and not tools is none %}
    {#- Extract the first user message so we can plug it in here #}
    {%- if messages | length != 0 %}
        {%- set first_user_message = messages[0]['content']|trim %}
        {%- set messages = messages[1:] %}
    {%- else %}
        {{- raise_exception("Cannot put tools in the first user message when there's no first user message!") }}
{%- endif %}
    {{- '<|start_header_id|>user<|end_header_id|>\n\n' -}}
    {{- "Given the following functions, please respond with a JSON for a function call " }}
    {{- "with its proper arguments that best answers the given prompt.\n\n" }}
    {{- 'Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}.' }}
    {{- "Do not use variables.\n\n" }}
    {%- for t in tools %}
        {{- t | tojson(indent=4) }}
        {{- "\n\n" }}
    {%- endfor %}
    {{- first_user_message + "<|eot_id|>"}}
{%- endif %}

{%- for message in messages %}
    {%- if not (message.role == 'ipython' or message.role == 'tool' or 'tool_calls' in message) %}
        {{- '<|start_header_id|>' + message['role'] + '<|end_header_id|>\n\n'+ message['content'] | trim + '<|eot_id|>' }}
    {%- elif 'tool_calls' in message %}
        {%- if not message.tool_calls|length == 1 %}
            {{- raise_exception("This model only supports single tool-calls at once!") }}
        {%- endif %}
        {%- set tool_call = message.tool_calls[0].function %}
        {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' -}}
        {{- '{"name": "' + tool_call.name + '", ' }}
        {{- '"parameters": ' }}
        {{- tool_call.arguments | tojson }}
        {{- "}" }}
        {{- "<|eot_id|>" }}
    {%- elif message.role == "tool" or message.role == "ipython" %}
        {{- "<|start_header_id|>ipython<|end_header_id|>\n\n" }}
        {%- if message.content is mapping or message.content is iterable %}
            {{- message.content | tojson }}
        {%- else %}
            {{- message.content }}
        {%- endif %}
        {{- "<|eot_id|>" }}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' }}
{%- endif %}
`

/**
 * Returns the canonical Meta Llama 3.x chat template when the embedded template
 * carries the strict system-message guard AND the model is Llama-3 format;
 * otherwise `null` (leave the embedded template untouched).
 */
export function resolveLlama3TemplateOverride(
  modelId: string,
  embeddedTemplate: string | null | undefined
): string | null {
  if (!embeddedTemplate) return null
  if (!embeddedTemplate.includes(STRICT_SYSTEM_GUARD_SIGNATURE)) return null

  const looksLikeLlama3 =
    LLAMA3_MODEL_ID_RE.test(modelId) ||
    embeddedTemplate.includes(LLAMA3_FORMAT_MARKER)
  if (!looksLikeLlama3) return null

  return CANONICAL_LLAMA3_CHAT_TEMPLATE
}
