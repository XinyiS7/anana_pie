---
description: Implementation plan document format (write to Plan/*.md)
argument-hint: "[topic]"
---
Create an implementation plan document with the following structure:

* **期望效果/施工理由**：[可验证的具体目标或 Bug 描述]
* **施工顺序**：[编号步骤：涉及文件、类/方法、精确行范围、初步签名、下游影响]
* **关键文件清单**：[标注 Create / Modify / Delete]
* **不变部分**：[明确 Scope 边界]
* **验证方式**：[具体的验证面与预期结果]
* **署名**：model / name - YYYY-MM-DD

Write the plan as a file under the project's `Plan/` directory (e.g. `Plan/${@:-<topic>}_Plan.md`), then summarize the plan briefly in chat.
