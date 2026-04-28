export const openAIProviderSettings = [
  {
    key: 'api-key',
    title: 'API Key',
    description:
      "The OpenAI API uses API keys for authentication. Visit your [API Keys](https://platform.openai.com/account/api-keys) page to retrieve the API key you'll use in your requests.",
    controller_type: 'input',
    controller_props: {
      placeholder: 'Insert API Key',
      value: '',
      type: 'password',
      input_actions: ['unobscure', 'copy'],
    },
  },
  {
    key: 'base-url',
    title: 'Base URL',
    description:
      'The base endpoint to use. See the [OpenAI API documentation](https://platform.openai.com/docs/api-reference/chat/create) for more information.',
    controller_type: 'input',
    controller_props: {
      placeholder: 'https://api.openai.com/v1',
      value: 'https://api.openai.com/v1',
    },
  },
]
export const predefinedProviders = [
  {
    active: true,
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    explore_models_url: 'https://platform.openai.com/docs/models',
    provider: 'openai',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The OpenAI API uses API keys for authentication. Visit your [API Keys](https://platform.openai.com/account/api-keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. See the [OpenAI API documentation](https://platform.openai.com/docs/api-reference/chat/create) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://api.openai.com/v1',
          value: 'https://api.openai.com/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
    explore_models_url: 'https://oai.azure.com/deployments',
    provider: 'azure',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          'The Azure OpenAI API uses API keys for authentication. Visit your [Azure OpenAI Studio](https://oai.azure.com/) to retrieve the API key from your resource.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'Your Azure OpenAI resource endpoint. See the [Azure OpenAI documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/latest) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
          value: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.anthropic.com/v1',
    provider: 'anthropic',
    explore_models_url:
      'https://docs.anthropic.com/en/docs/about-claude/models',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Anthropic API uses API keys for authentication. Visit your [API Keys](https://console.anthropic.com/settings/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. See the [Anthropic API documentation](https://docs.anthropic.com/en/api/messages) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://api.anthropic.com/v1',
          value: 'https://api.anthropic.com/v1',
        },
      },
    ],
    models: [],
    custom_header: [
      {
        header: 'anthropic-version',
        value: '2023-06-01'
      },
      {
        header: 'anthropic-dangerous-direct-browser-access',
        value: 'true'
      }
    ]
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://openrouter.ai/api/v1',
    explore_models_url: 'https://openrouter.ai/models',
    provider: 'openrouter',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The OpenRouter API uses API keys for authentication. Visit your [API Keys](https://openrouter.ai/settings/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. See the [OpenRouter API documentation](https://openrouter.ai/docs/api-reference/overview) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://openrouter.ai/api/v1',
          value: 'https://openrouter.ai/api/v1',
        },
      },
    ],
    // Top models curated from https://openrouter.ai/rankings (Apr 2026).
    // Slug IDs verified against https://openrouter.ai/api/v1/models.
    models: [
      {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        version: '1.0',
        description:
          'Best balance of speed and intelligence from Anthropic. 1M ctx, vision + tools.',
        capabilities: ['completion', 'tools', 'vision'],
      },
      {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude Opus 4.6',
        version: '1.0',
        description:
          'Anthropic flagship for complex reasoning and agentic coding. 1M ctx, vision + tools.',
        capabilities: ['completion', 'tools', 'vision'],
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        version: '1.0',
        description:
          'DeepSeek flagship MoE (1.6T total / 49B active) for advanced reasoning, coding, and long-horizon agents. 1M ctx.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        version: '1.0',
        description:
          'Efficiency-optimized MoE (284B total / 13B active) for fast, cost-effective reasoning and coding. 1M ctx.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'deepseek/deepseek-v3.2',
        name: 'DeepSeek V3.2',
        version: '1.0',
        description:
          'High-performance open-weight reasoning model with strong tool use.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'google/gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        version: '1.0',
        description:
          "Google's frontier-class Flash model. Low-latency multimodal reasoning.",
        capabilities: ['completion', 'tools', 'vision'],
      },
      {
        id: 'google/gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        version: '1.0',
        description:
          'Most budget-friendly stable Gemini model. Multimodal, tool-capable.',
        capabilities: ['completion', 'tools', 'vision'],
      },
      {
        id: 'openai/gpt-5.4',
        name: 'GPT-5.4',
        version: '1.0',
        description:
          "OpenAI's flagship for complex reasoning and coding. 1M ctx, vision + tools.",
        capabilities: ['completion', 'tools', 'vision'],
      },
      {
        id: 'minimax/minimax-m2.7',
        name: 'MiniMax M2.7',
        version: '1.0',
        description:
          'Latest MiniMax flagship with enhanced reasoning and coding abilities.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'minimax/minimax-m2.5',
        name: 'MiniMax M2.5',
        version: '1.0',
        description:
          'High-performance long-context model from MiniMax. 204K ctx.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'xiaomi/mimo-v2-pro',
        name: 'Xiaomi MiMo V2 Pro',
        version: '1.0',
        description:
          "Xiaomi's frontier open-weight model for reasoning and coding.",
        capabilities: ['completion', 'tools'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.mistral.ai/v1',
    explore_models_url:
      'https://docs.mistral.ai/getting-started/models/models_overview/',
    provider: 'mistral',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Mistral API uses API keys for authentication. Visit your [API Keys](https://console.mistral.ai/api-keys/) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. See the [Mistral documentation](https://docs.mistral.ai/getting-started/models/models_overview/) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://api.mistral.ai/v1',
          value: 'https://api.mistral.ai/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.groq.com/openai/v1',
    explore_models_url: 'https://console.groq.com/docs/models',
    provider: 'groq',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Groq API uses API keys for authentication. Visit your [API Keys](https://console.groq.com/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base OpenAI-compatible endpoint to use. See the [Groq documentation](https://console.groq.com/docs) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://api.groq.com/openai/v1',
          value: 'https://api.groq.com/openai/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.x.ai/v1',
    explore_models_url: 'https://docs.x.ai/overview',
    provider: 'xai',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The xAI API uses API keys for authentication. Visit your [API Keys](https://console.x.ai/) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. See the [xAI API documentation](https://docs.x.ai/overview) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://api.x.ai/v1',
          value: 'https://api.x.ai/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    explore_models_url: 'https://ai.google.dev/gemini-api/docs/models/gemini',
    provider: 'gemini',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Google API uses API keys for authentication. Visit your [API Keys](https://aistudio.google.com/apikey) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base OpenAI-compatible endpoint to use. See the [Gemini documentation](https://ai.google.dev/gemini-api/docs/openai) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder:
            'https://generativelanguage.googleapis.com/v1beta/openai',
          value: 'https://generativelanguage.googleapis.com/v1beta/openai',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.minimax.io/v1',
    explore_models_url: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    provider: 'minimax',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The MiniMax API uses API keys for authentication. Visit your [API Keys](https://platform.minimax.io/user-center/basic-information/interface-key) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. Use `https://api.minimax.io/v1` for global access or `https://api.minimaxi.com/v1` for users in China. See the [MiniMax API documentation](https://platform.minimax.io/docs/api-reference/text-openai-api) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://api.minimax.io/v1',
          value: 'https://api.minimax.io/v1',
        },
      },
    ],
    models: [
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        version: '1.0',
        description: 'Latest flagship model with enhanced reasoning and coding.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax-M2.7-highspeed',
        version: '1.0',
        description: 'High-speed version of M2.7 for low-latency scenarios.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'MiniMax-M2.5',
        name: 'MiniMax-M2.5',
        version: '1.0',
        description: 'Peak Performance. Ultimate Value. Master the Complex. 204K context window.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'MiniMax-M2.5-highspeed',
        name: 'MiniMax-M2.5-highspeed',
        version: '1.0',
        description: 'Same performance, faster and more agile. 204K context window.',
        capabilities: ['completion', 'tools'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://router.huggingface.co/v1',
    explore_models_url:
      'https://huggingface.co/models?pipeline_tag=text-generation&inference_provider=all',
    provider: 'huggingface',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Hugging Face API uses tokens for authentication. Visit your [Access Tokens](https://huggingface.co/settings/tokens) page to retrieve the token you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Token',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. See the [Hugging Face Inference Providers documentation](https://huggingface.co/docs/inference-providers) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://router.huggingface.co/v1',
          value: 'https://router.huggingface.co/v1',
        },
      },
    ],
    models: [
      {
        id: 'moonshotai/Kimi-K2-Instruct:groq',
        name: 'Kimi-K2-Instruct',
        version: '1.0',
        description:
          '1T parameters Moonshot chat model tuned for tool-aware, nuanced responses.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-0528',
        name: 'DeepSeek-R1-0528',
        version: '1.0',
        description:
          "DeepSeek's flagship reasoning engine with open weights and advanced tool control.",
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'deepseek-ai/DeepSeek-V3-0324',
        name: 'DeepSeek-V3-0324',
        version: '1.0',
        description:
          'Streamlined DeepSeek model focused on fast, high-quality completions and tool use.',
        capabilities: ['completion', 'tools'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://integrate.api.nvidia.com/v1',
    explore_models_url: 'https://build.nvidia.com/models',
    provider: 'nvidia',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The NVIDIA NIM API uses API keys for authentication. Visit [NVIDIA NGC API Keys](https://org.ngc.nvidia.com/setup/api-keys) to create an API key for your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The NVIDIA NIM OpenAI-compatible endpoint to use. See the [NVIDIA NIM API documentation](https://docs.api.nvidia.com/nim/reference/llm-apis) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://integrate.api.nvidia.com/v1',
          value: 'https://integrate.api.nvidia.com/v1',
        },
      },
    ],
    models: [],
  },
]
