with open("web-app/src/lib/__tests__/ipc-contract.test.ts", "r") as f:
    content = f.read()

content = content.replace("'get_local_http',", "'get_local_http',\n  'media_engine_install',\n  'media_engine_start',\n  'media_engine_status',\n  'media_engine_stop',")

with open("web-app/src/lib/__tests__/ipc-contract.test.ts", "w") as f:
    f.write(content)

with open("web-app/src/containers/__tests__/ReplyModelGate.test.tsx", "r") as f:
    content = f.read()

original = """    expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
      'AtomicChat/Qwen3.5-4B-Q4_K_M',
      'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
      undefined,
      '',
      true,
      false
    )"""

replacement = """    await waitFor(() =>
      expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
        'AtomicChat/Qwen3.5-4B-Q4_K_M',
        'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
        undefined,
        '',
        true,
        false
      )
    )"""

content = content.replace(original, replacement)

with open("web-app/src/containers/__tests__/ReplyModelGate.test.tsx", "w") as f:
    f.write(content)
