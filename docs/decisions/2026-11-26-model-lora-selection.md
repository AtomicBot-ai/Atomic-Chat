---
date: 2026-11-26
title: "Bind LoRA adapters to local model installations"
---

# Bind LoRA adapters to local model installations

Core stores the selected adapter by modality and model installation. Catalog entries and Hugging Face metadata identify the base checkpoint. Downloads use immutable revisions and verified file hashes.

For upstream llama.cpp a selection recreates the loaded session with its existing settings, including DSpark. A failed load restores the previous binding. Local image and video jobs acquire the selected file when submitted and keep it through retries. Each job checks the installed server's LoRA capability for its generation mode before sending the structured request.

The Hub, Downloads and model settings read the same control API. Clearing a selection keeps the downloaded weights available to other installations.
