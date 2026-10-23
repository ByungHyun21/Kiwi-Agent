// Host key pinning helpers: fingerprinting, key selection and known_hosts paths.

import { describe, expect, test } from "bun:test";
import {
  chooseHostKey,
  hostKeyFileName,
  hostKeyFingerprint,
  knownHostsSpec,
  parseHostKeys,
} from "../src/ssh.ts";

const ed25519 =
  "127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKugFfXASL8DTXJCzIn5pgJ+cpjpyxwrDxlSblfD2eKh";
const rsa = "127.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDliKjbbqPi4VwhTt2wNetctLe9fF/XkXQQ4fnNsn36FMYu++amKXeDih70xdoIF3bWDJbena7S3CIaq6KKyVR3PNELr3jek4LgOx2ZQWkc6nKsNkQ1IRCE7lYQUGCKKnaVCGFU+NK/y8Xv6nK6HN+OFQ1odH5lDv20ZNvDhjJI/+jDEjVxt2GG4S948ztBx35bLEkqL7PC0l+nWRnekoRXNNA6EbOtjgMgKmhbiWFzOJ883bhi0NdZc7qa3TNIg+/LLUENEsfUYimRPb31mYTu6EaMTr4gTUlISdvff55wlLK0hGfltmg98b2xP0YeYeWIaZZ+F3gAgD8zKsPuL3ATsi7qOFjBHIxIPN9oKddozjKhFTu1uC+qSLYkC+CN2yvxyHrAGhPswpuihc9Wlij5phcIiNfuV0NMjqBxKwQJWAjtul6uf1UyUmj9MAulBSq717p2M05qzi8YZi/dRrs+kIFG1ZrFRvNu+HveykvRvvtO0fP5Ya6EXHRa6SwCAmc=";

describe("host key fingerprint", () => {
  test("matches ssh-keygen -lf", () => {
    expect(hostKeyFingerprint(ed25519)).toBe("SHA256:9Ihxt1ZQ7o0DfHRr3d4jNi9AQ+KH0gb8tQuhEipUM08");
  });
});

describe("host key selection", () => {
  test("prefers ed25519 over RSA", () => {
    expect(chooseHostKey([rsa, ed25519])).toBe(ed25519);
  });

  test("parses ssh-keyscan output", () => {
    const out = `# 127.0.0.1:22 SSH-2.0-OpenSSH_9.6\n\n${ed25519}\n${rsa}\n`;
    expect(parseHostKeys(out)).toEqual([ed25519, rsa]);
  });
});

describe("known_hosts naming", () => {
  test("uses [host]:port only for nonstandard ports and IPv6", () => {
    expect(knownHostsSpec("127.0.0.1", 22)).toBe("127.0.0.1");
    expect(knownHostsSpec("127.0.0.1", 2222)).toBe("127.0.0.1:2222");
    expect(knownHostsSpec("::1", 22)).toBe("[::1]:22");
  });

  test("file names are stable and safe", () => {
    const a = hostKeyFileName("my box/1");
    expect(a).toBe(hostKeyFileName("my box/1"));
    expect(a).toMatch(/^[A-Za-z0-9._-]+\.known_hosts$/);
    expect(hostKeyFileName("my box/1")).not.toBe(hostKeyFileName("my box_1"));
  });
});
