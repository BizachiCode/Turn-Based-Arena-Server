#!/usr/bin/env sh
# Regenerates the TEST certificate chain used by test/iap_app_store_test.ts (NOT Apple's: a local root with the same
# marker extensions Apple puts on its App Store signing chain). Run from this folder: sh generate.sh
set -e
cat > ext.cnf <<'EOF'
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
1.2.840.113635.100.6.11.1 = ASN1:NULL
[rogue]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
EOF

openssl ecparam -name prime256v1 -genkey -noout -out root.key
openssl req -new -x509 -key root.key -subj "/CN=Test Root CA/O=Turn-Based Arena Tests" -days 36500 -sha256 \
  -extensions root -config ext.cnf -out root.pem
openssl ecparam -name prime256v1 -genkey -noout -out intermediate.key
openssl req -new -key intermediate.key -subj "/CN=Test Intermediate CA/O=Turn-Based Arena Tests" -out intermediate.csr
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -CAcreateserial -days 36500 -sha256 \
  -extfile ext.cnf -extensions intermediate -out intermediate.pem
for name in leaf rogue; do
  openssl ecparam -name prime256v1 -genkey -noout -out "$name.key"
  openssl req -new -key "$name.key" -subj "/CN=Test $name/O=Turn-Based Arena Tests" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -CA intermediate.pem -CAkey intermediate.key -CAcreateserial -days 36500 -sha256 \
    -extfile ext.cnf -extensions "$name" -out "$name.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$name.key" -out "$name.key.pem"
done
openssl x509 -in root.pem -outform der -out root.cer
rm -f ./*.csr ./*.srl ext.cnf root.key intermediate.key leaf.key rogue.key
