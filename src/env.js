// A secret comes from the environment, or from a file the environment names (<NAME>_FILE), so a host that
// mounts PEMs and tokens read-only keeps the container's environment free of secrets (nothing to leak through
// `docker inspect` or a child process), while a platform whose secrets are variables works unchanged. A PEM
// pasted into a variable carries \n for its line breaks; a file's trailing newline is trimmed.
import fs from 'node:fs';

export function secret(name, { required = false } = {}) {
  const file = process.env[`${name}_FILE`];
  const raw = file ? fs.readFileSync(file, 'utf8').trim() : process.env[name];
  if (!raw && required) throw new Error(`${name} (or ${name}_FILE) is not set`);
  return raw ? raw.replace(/\\n/g, '\n') : raw;
}
