import re

with open("web-app/src/lib/__tests__/ipc-contract.test.ts", "r") as f:
    content = f.read()

original = """  'get_local_http',
  'media_engine_install',
  'media_engine_start',
  'media_engine_status',
  'media_engine_stop',
  'media_engine_install',
  'media_engine_start',
  'media_engine_status',
  'media_engine_stop',
  // Radium Media provider"""

replacement = """  'get_local_http',
  'media_engine_install',
  'media_engine_start',
  'media_engine_status',
  'media_engine_stop',
  // Radium Media provider"""

content = content.replace(original, replacement)

with open("web-app/src/lib/__tests__/ipc-contract.test.ts", "w") as f:
    f.write(content)
