/** Client for the TEE node's local sign/decrypt port (never leaves the enclave host). */

import http from 'node:http';

let signPort = '9090';

/** Set the sign port for communicating with the TEE node. */
export function setSignPort(port: string): void {
  signPort = port;
}

export function getSignPort(): string {
  return signPort;
}

/**
 * Call the TEE node's /decrypt endpoint.
 * Sends ciphertext as base64-encoded bytes (matching Go's []byte JSON marshaling).
 * Returns the decrypted plaintext bytes.
 */
export function decryptViaNode(ciphertext: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${signPort}/decrypt`;
    const body = JSON.stringify({
      encryptedMessage: Buffer.from(ciphertext).toString('base64'),
    });

    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`node returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(
              new Uint8Array(Buffer.from(parsed.decryptedMessage, 'base64')),
            );
          } catch (e) {
            reject(new Error(`decode response: ${e}`));
          }
        });
      },
    );

    req.on('error', (e) => reject(new Error(`request error: ${e.message}`)));
    req.write(body);
    req.end();
  });
}
