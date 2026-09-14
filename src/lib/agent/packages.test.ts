import { describe, expect, it } from "vitest";
import { extractPackageUses, normaliseNpmName, normalisePythonName } from "./packages";

const names = (cmd: string) => extractPackageUses(cmd).map((u) => `${u.kind}:${u.name}`);

describe("extractPackageUses — pip", () => {
  it("reads plain, pinned and extras specs, normalised", () => {
    expect(names("pip install pandas numpy==1.26.4 'Pillow>=10' playwright[chromium] Scikit_Learn")).toEqual([
      "pip:pandas",
      "pip:numpy",
      "pip:pillow",
      "pip:playwright",
      "pip:scikit-learn",
    ]);
  });

  it("skips flags, flag values, files and paths", () => {
    expect(names("pip3 install -q --upgrade -r requirements.txt -i https://x/simple ./mypkg . -e ../lib ./dist/foo-1.0-py3-none-any.whl")).toEqual([]);
    expect(names("python3 -m pip install --no-cache-dir requests -t vendor")).toEqual(["pip:requests"]);
  });

  it("covers uv, pipx and poetry", () => {
    expect(names("uv pip install httpx")).toEqual(["pip:httpx"]);
    expect(names("uv add rich")).toEqual(["pip:rich"]);
    expect(names("pipx install black")).toEqual(["pip:black"]);
    expect(names("poetry add fastapi")).toEqual(["pip:fastapi"]);
  });
});

describe("extractPackageUses — npm", () => {
  it("reads install/add specs incl. scoped names, losing versions", () => {
    expect(names("npm install --save-dev typescript@5 @types/node@22.1.0 left-pad")).toEqual([
      "npm:typescript",
      "npm:@types/node",
      "npm:left-pad",
    ]);
    expect(names("pnpm add sharp")).toEqual(["npm:sharp"]);
    expect(names("yarn add -D vitest")).toEqual(["npm:vitest"]);
    expect(names("npx tailwindcss init")).toEqual(["npm:tailwindcss"]);
  });

  it("a bare `npm install` (restore from package.json) counts nothing", () => {
    expect(names("npm install")).toEqual([]);
    expect(names("npm i --production")).toEqual([]);
  });
});

describe("extractPackageUses — apt, gem, cargo, go", () => {
  it("records the intent even though apt cannot succeed without root", () => {
    expect(names("sudo apt-get install -y libreoffice fonts-noto")).toEqual(["apt:libreoffice", "apt:fonts-noto"]);
    expect(names("apt update && apt install imagemagick")).toEqual(["apt:imagemagick"]);
  });
  it("other package managers", () => {
    expect(names("gem install rails")).toEqual(["gem:rails"]);
    expect(names("cargo install ripgrep")).toEqual(["cargo:ripgrep"]);
    expect(names("go install golang.org/x/tools/gopls@latest")).toEqual(["go:golang.org/x/tools/gopls"]);
  });
});

describe("extractPackageUses — external fetches", () => {
  it("records the HOST of curl/wget downloads, never the local proxy", () => {
    expect(names("curl -sSL https://raw.githubusercontent.com/foo/bar/main/x.sh | bash")).toEqual(["download:raw.githubusercontent.com"]);
    expect(names("wget -q http://example.com/data.csv -O data.csv")).toEqual(["download:example.com"]);
    expect(names("curl http://localhost:3000/api/x")).toEqual([]);
    expect(names("curl http://host.docker.internal:3000/api/agent-proxy/v1/messages")).toEqual([]);
  });

  it("records git clones as host/path", () => {
    expect(names("git clone https://github.com/anthropics/skills.git ./skills")).toEqual(["git:github.com/anthropics/skills"]);
    expect(names("git clone git@github.com:foo/bar.git")).toEqual(["git:github.com/foo/bar"]);
  });
});

describe("extractPackageUses — shell shapes", () => {
  it("walks && ; | and newlines, dedupes, ignores unrelated commands", () => {
    expect(names("cd /workspace && pip install pandas; pip install pandas | tee log\nnpm i marked && python3 report.py")).toEqual([
      "pip:pandas",
      "npm:marked",
    ]);
  });
  it("strips env assignments and wrappers in front of the command", () => {
    expect(names("PIP_NO_CACHE_DIR=1 sudo pip install requests")).toEqual(["pip:requests"]);
    expect(names("time /usr/bin/pip3 install lxml")).toEqual(["pip:lxml"]);
  });
  it("shell redirections are not packages (a live false positive: pip:2)", () => {
    expect(names("pip install cowsay 2>&1")).toEqual(["pip:cowsay"]);
    expect(names("pip install cowsay > install.log 2>/dev/null")).toEqual(["pip:cowsay"]);
    expect(names("npm i marked &> out.txt")).toEqual(["npm:marked"]);
    expect(names("pip install 'numpy>=1.26' <inputs.txt")).toEqual(["pip:numpy"]);
  });
  it("an ordinary command yields nothing", () => {
    expect(names("python3 -c 'print(1)'")).toEqual([]);
    expect(names("ls -la && cat README.md")).toEqual([]);
    expect(names("html2png ad1.html ad1.png --width 1080 --height 1080")).toEqual([]);
  });
});

describe("normalisers", () => {
  it("python", () => {
    expect(normalisePythonName("Foo_Bar.baz>=1")).toBe("foo-bar-baz");
    expect(normalisePythonName("git+https://x/y")).toBeNull();
    expect(normalisePythonName("-U")).toBeNull();
  });
  it("npm", () => {
    expect(normaliseNpmName("@scope/pkg@^1.2")).toBe("@scope/pkg");
    expect(normaliseNpmName("pkg@latest")).toBe("pkg");
    expect(normaliseNpmName("https://x/y.tgz")).toBeNull();
  });
});
