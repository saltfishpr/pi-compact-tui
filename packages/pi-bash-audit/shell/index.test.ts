import { describe, expect, it } from "vitest";

import { isReadOnly } from "./index";

describe("isReadOnly", () => {
  describe("empty / invalid input", () => {
    it.each(["", "   ", "\n\t"])("rejects blank source %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });

    it("rejects unparseable source", () => {
      expect(isReadOnly("echo 'unterminated")).toBe(false);
    });
  });

  describe("single commands", () => {
    it.each([
      "pwd",
      "whoami",
      "ls -la",
      "cat README.md",
      "head -n 20 README.md",
      "tail -f app.log",
      "grep -R 'TODO' src",
      "wc -l package.json",
      "echo hello world",
      "hostname -s",
      "date '+%Y-%m-%dT%H:%M:%SZ'",
      "date -u",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each([
      "rm -rf build",
      "mv src dst",
      "cp a b",
      "curl https://example.com",
      "wget https://example.com/file",
      "npm install",
      "pnpm add zod",
      "sudo ls",
    ])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });

  describe("git subcommands", () => {
    it.each([
      "git status",
      "git status -sb",
      "git diff --cached",
      "git log --oneline -20",
      "git show HEAD",
      "git branch -a",
      "git branch --show-current",
      "git remote -v",
      "git remote get-url origin",
      "git config --get user.email",
      "git config --list",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each([
      "git commit -m 'feat: add feature'",
      "git push origin main",
      "git pull",
      "git fetch --all",
      "git checkout main",
      "git branch new-branch",
      "git config user.email me@example.com",
    ])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });

  describe("search commands", () => {
    it.each([
      "rg -n 'TODO' src",
      "rg --hidden --no-ignore 'foo'",
      "rg -tts 'pattern'",
      "fd --hidden --type f",
      "fd -e ts",
      "find . -name '*.ts' -type f",
      "find . -maxdepth 3 -name 'README*'",
      "tree -L 2 src",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each(["find . -name '*.log' -delete", "find . -exec rm {} \\;"])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });

  describe("go subcommands", () => {
    it.each([
      "go version",
      "go env",
      "go env GOPATH GOROOT",
      "go doc fmt",
      "go list ./...",
      "go list -m all",
      "go mod graph",
      "go mod why golang.org/x/text",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each([
      "go build ./...",
      "go test ./...",
      "go run main.go",
      "go get example.com/pkg",
      "go install example.com/cmd/foo",
      "go mod tidy",
    ])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });

  describe("pipelines", () => {
    it.each([
      "ls -la | wc -l",
      "cat log.txt | grep ERROR | head -n 20",
      "git log --oneline | head -n 5",
      "rg -n 'TODO' src | wc -l",
      "ps | grep node",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each(["cat file | tee out.txt", "ls | xargs rm"])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });

  describe("and/or lists", () => {
    it.each([
      "git status && git log --oneline -5",
      "[[ -d src ]] && ls src",
      "cat README.md || echo missing",
      "which node && echo present",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each(["git status && git commit -am wip", "cat file || rm file"])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });

  describe("redirects", () => {
    it.each(["grep TODO < README.md", "wc -l < package.json", "cat <<< 'hello'", "cat <<'EOF'\nhello\nEOF"])(
      "allows read-only redirects %j",
      (source) => {
        expect(isReadOnly(source)).toBe(true);
      },
    );

    it.each(["echo hi > out.txt", "echo hi >> out.txt", "cat file 2> err.log", "cat file &> combined.log"])(
      "rejects write redirects %j",
      (source) => {
        expect(isReadOnly(source)).toBe(false);
      },
    );
  });

  describe("background / expansion", () => {
    it.each([
      "ls &",
      "echo $HOME",
      'echo "$USER"',
      "cat $(git rev-parse --show-toplevel)/README.md",
      "ls `pwd`",
      "cat ~/.bashrc",
      "ls *.ts",
      "ls file?.txt",
    ])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });

    it.each(["echo 'literal $HOME'", 'echo "plain text"'])("allows literal-only strings %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });
  });

  describe("compound structures", () => {
    it.each([
      "if [[ -f README.md ]]; then cat README.md; fi",
      "if git status; then git log --oneline -3; else echo no repo; fi",
      "(cat README.md; ls src)",
      "{ pwd; ls; }",
      "case foo in bar) echo one;; foo) echo two;; esac",
    ])("allows %j", (source) => {
      expect(isReadOnly(source)).toBe(true);
    });

    it.each([
      "for f in *.ts; do cat $f; done",
      "while true; do ls; done",
      "for f in a b c; do cat $f; done",
      "myfunc() { ls; }",
      "if [[ -f README.md ]]; then rm README.md; fi",
    ])("rejects %j", (source) => {
      expect(isReadOnly(source)).toBe(false);
    });
  });
});
