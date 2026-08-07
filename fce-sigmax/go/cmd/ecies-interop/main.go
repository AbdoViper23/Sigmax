// Command ecies-interop proves that the browser-side encryption in packages/cdr/src/ecies.ts is
// byte-compatible with the ECIES the FCC tee-node actually uses.
//
// It links the SAME go-ethereum version as the tee-node, so a pass here means a signal encrypted in
// the leader's browser really can be decrypted inside the enclave — the single assumption the whole
// confidentiality story rests on.
//
// Usage:
//
//	go run ./cmd/ecies-interop <ts-fixture.json> <out-reverse-fixture.json>
//
// It (1) decrypts a TypeScript-produced ciphertext and checks the plaintext, then (2) writes a
// geth-produced ciphertext for the TypeScript side to decrypt. That second file is committed as
// packages/cdr/test/fixtures/geth-ecies-vector.json so the interop stays covered by `pnpm test`.
package main

import (
	"crypto/ecdsa"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"
)

type fixture struct {
	PrivateKey        string `json:"privateKey"`
	Ciphertext        string `json:"ciphertext"`
	ExpectedPlaintext string `json:"expectedPlaintext"`
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s[2:])
	if err != nil {
		panic(err)
	}
	return b
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		panic(err)
	}

	var ecdsaPriv *ecdsa.PrivateKey
	ecdsaPriv, err = crypto.ToECDSA(mustHex(f.PrivateKey))
	if err != nil {
		panic(err)
	}
	eciesPriv := ecies.ImportECDSA(ecdsaPriv)

	// This is exactly what the tee-node's /decrypt endpoint does.
	plaintext, err := eciesPriv.Decrypt(mustHex(f.Ciphertext), nil, nil)
	if err != nil {
		fmt.Println("FAIL: geth could not decrypt the TypeScript ciphertext:", err)
		os.Exit(1)
	}

	got := "0x" + hex.EncodeToString(plaintext)
	if got != f.ExpectedPlaintext {
		fmt.Printf("FAIL: plaintext mismatch\n  got:  %s\n  want: %s\n", got, f.ExpectedPlaintext)
		os.Exit(1)
	}
	fmt.Printf("PASS: go-ethereum decrypted the TypeScript ciphertext (%d bytes)\n", len(plaintext))

	// Reverse direction: geth encrypts, TypeScript must decrypt it.
	msg := []byte("go-side-plaintext-for-reverse-interop")
	ct, err := ecies.Encrypt(crand.Reader, &eciesPriv.PublicKey, msg, nil, nil)
	if err != nil {
		panic(err)
	}
	out, _ := json.Marshal(map[string]string{
		"privateKey":        f.PrivateKey,
		"ciphertext":        "0x" + hex.EncodeToString(ct),
		"expectedPlaintext": "0x" + hex.EncodeToString(msg),
	})
	os.WriteFile(os.Args[2], out, 0o644)
	fmt.Println("wrote reverse fixture")
}
