// Parsing for `VBoxManage guestproperty enumerate`, whose output changed
// between major versions:
//
//   VirtualBox 7:  /VirtualBox/GuestInfo/Net/0/V4/IP = '10.0.2.15' @ 2026-01-01T00:00:00.000Z
//   VirtualBox 6:  Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, timestamp: 1700000000, flags:
//
// Both are read, so the tools work whichever VirtualBox is installed.

const V7_LINE = /^(\S+)\s*=\s*'(.*)'\s*@/;
const V6_LINE = /^Name:\s*(.+?),\s*value:\s*(.*?),\s*timestamp:/;

export function parseGuestProperties(output: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const match = line.match(V7_LINE) ?? line.match(V6_LINE);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// The guest's IPv4 addresses, one per network adapter that has one, in
// adapter order. An adapter that is down reports 0.0.0.0, which is no address.
export function guestIPv4Addresses(output: string): string[] {
  const props = parseGuestProperties(output);
  return Object.keys(props)
    .filter((name) => /^\/VirtualBox\/GuestInfo\/Net\/\d+\/V4\/IP$/.test(name))
    .sort((a, b) => adapterIndex(a) - adapterIndex(b))
    .map((name) => props[name])
    .filter((ip) => IPV4.test(ip) && ip !== "0.0.0.0");
}

function adapterIndex(name: string): number {
  return Number(name.match(/\/Net\/(\d+)\//)?.[1] ?? 0);
}
