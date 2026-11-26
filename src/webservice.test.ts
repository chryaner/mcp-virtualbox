import { describe, it, expect } from "vitest";
import {
  apiCoordinate,
  authSimpleHash,
  BUTTON_SETTLE_MS,
  parseSoapResponse,
  pauseBefore,
  registeredUserPids,
  soapEnvelope,
  webServiceCandidates,
} from "./webservice.js";

describe("soapEnvelope", () => {
  it("wraps a method and its arguments in order", () => {
    const xml = soapEnvelope("IMouse_putMouseEventAbsolute", [["_this", "ref-1"], ["x", 101], ["y", 201], ["buttonState", 1]]);
    expect(xml).toContain("<vbox:IMouse_putMouseEventAbsolute><_this>ref-1</_this><x>101</x><y>201</y><buttonState>1</buttonState></vbox:IMouse_putMouseEventAbsolute>");
    expect(xml).toContain('xmlns:vbox="http://www.virtualbox.org/"');
  });

  it("escapes a VM name that is not safe XML", () => {
    const xml = soapEnvelope("IVirtualBox_findMachine", [["nameOrId", `a<b>&"c`]]);
    expect(xml).toContain("<nameOrId>a&lt;b&gt;&amp;&quot;c</nameOrId>");
  });

  it("sends a method with no arguments", () => {
    expect(soapEnvelope("M", [])).toContain("<vbox:M></vbox:M>");
  });
});

describe("parseSoapResponse", () => {
  const envelope = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vbox="http://www.virtualbox.org/"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  it("reads a return value", () => {
    const xml = envelope("<vbox:IWebsessionManager_logonResponse><returnval>a1b2-0000000000000001</returnval></vbox:IWebsessionManager_logonResponse>");
    expect(parseSoapResponse(xml)).toEqual({ value: "a1b2-0000000000000001" });
  });

  it("reads a method that returns nothing", () => {
    expect(parseSoapResponse(envelope("<vbox:ISession_unlockMachineResponse></vbox:ISession_unlockMachineResponse>"))).toEqual({ value: "" });
  });

  it("unescapes the value", () => {
    expect(parseSoapResponse(envelope("<r><returnval>a &amp; b &lt;c&gt;</returnval></r>")).value).toBe("a & b <c>");
  });

  it("reports a fault by its text", () => {
    const xml = envelope("<SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>VirtualBox error: Could not find a registered machine named 'nope'</faultstring></SOAP-ENV:Fault>");
    expect(parseSoapResponse(xml).fault).toBe("VirtualBox error: Could not find a registered machine named 'nope'");
  });

  it("reports a fault that has only a code, as a refused login does", () => {
    const xml = envelope("<SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode></SOAP-ENV:Fault>");
    expect(parseSoapResponse(xml).fault).toBe("SOAP-ENV:Client");
  });

  it("does not take something else for an answer", () => {
    expect(parseSoapResponse("<html>502 Bad Gateway</html>").fault).toMatch(/not a SOAP envelope/);
    expect(parseSoapResponse("").fault).toMatch(/not a SOAP envelope/);
  });
});

describe("apiCoordinate", () => {
  it("shifts a screenshot pixel to the API's 1-based position", () => {
    expect(apiCoordinate(0)).toBe(1);
    expect(apiCoordinate(100)).toBe(101);
  });

  it("rounds a fractional pixel", () => {
    expect(apiCoordinate(99.6)).toBe(101);
  });
});

describe("authSimpleHash", () => {
  it("is the SHA-256 of the password in hex, as VBoxAuthSimple stores it", () => {
    expect(authSimpleHash("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
  });
});

describe("pauseBefore", () => {
  const at = (buttons: number) => ({ x: 1, y: 1, buttons });

  it("does not wait before the first event", () => {
    expect(pauseBefore([at(0), at(1)], 0, 20)).toBe(0);
  });

  it("gives a press and a release time to register", () => {
    const click = [at(0), at(1), at(0)];
    expect(pauseBefore(click, 1, 20)).toBe(BUTTON_SETTLE_MS);
    expect(pauseBefore(click, 2, 20)).toBe(BUTTON_SETTLE_MS);
  });

  it("lets a pointer that only moves go as fast as asked", () => {
    expect(pauseBefore([at(1), at(1), at(1)], 2, 20)).toBe(20);
    expect(pauseBefore([at(0), at(0)], 1, 0)).toBe(0);
  });

  it("never shortens a longer gap", () => {
    expect(pauseBefore([at(0), at(1)], 1, 500)).toBe(500);
  });
});

describe("registeredUserPids", () => {
  it("finds this program's users among everything else in global extradata", () => {
    const extradata = [
      "Key: GUI/LastWindowPosition, Value: 100,100,800,600",
      "Key: VBoxAuthSimple/users/mcp-virtualbox-4242, Value: 0dfa6dfe6ee2be2f",
      "Key: VBoxAuthSimple/users/terrarium, Value: abcdef",
      "Key: VBoxAuthSimple/users/mcp-virtualbox-17, Value: 99",
      "",
    ].join("\n");
    expect(registeredUserPids(extradata)).toEqual([4242, 17]);
  });

  it("finds nothing in an empty configuration", () => {
    expect(registeredUserPids("No extra data items configured\n")).toEqual([]);
  });
});

describe("webServiceCandidates", () => {
  it("looks beside VBoxManage on Windows, under its Windows name", () => {
    const found = webServiceCandidates("C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe", "win32");
    expect(found[0]).toMatch(/VirtualBox[\\/]VBoxWebSrv\.exe$/);
  });

  it("looks beside VBoxManage and in the usual install folders on Linux", () => {
    const found = webServiceCandidates("/usr/bin/VBoxManage", "linux");
    expect(found.map((p) => p.replace(/\\/g, "/"))).toEqual(
      expect.arrayContaining(["/usr/bin/vboxwebsrv", "/usr/lib/virtualbox/vboxwebsrv", "/opt/VirtualBox/vboxwebsrv"]),
    );
  });

  it("knows the application bundle on macOS", () => {
    const found = webServiceCandidates("VBoxManage", "darwin");
    expect(found.map((p) => p.replace(/\\/g, "/"))).toEqual(["/Applications/VirtualBox.app/Contents/MacOS/vboxwebsrv"]);
  });

  it("has nowhere to look for a bare command name on Windows", () => {
    expect(webServiceCandidates("VBoxManage", "win32")).toEqual([]);
  });
});
