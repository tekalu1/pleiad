# desktop/computer/ の出典

`desktop/computer/` の Win32 の呼び出し（SendInput の組み立て・キー名の表・座標の写像・撮影の流れ）は、次の 2 つの MIT のプロジェクトの
実装を読んで、koffi（Node.js）向けに書き直したものです。

- [sshh12/windows-computer-use-mcp](https://github.com/sshh12/windows-computer-use-mcp)（`input.py`・`keymap.py`・`coords.py`・`capture.py`・`displays.py`・`dpi.py`）
- [Jason26214/omni-computer-use](https://github.com/Jason26214/omni-computer-use)（`keymap.py`・`apps.py`・`inputs.py`）

ネイティブの呼び出しには [koffi](https://koffi.dev/)（MIT、Copyright (C) 2026 Niels Martignène）を使います。

MIT License

Copyright (c) 2026 sshh12
Copyright (c) 2026 Jason26214

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
