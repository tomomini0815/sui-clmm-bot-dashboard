import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const priv = 'suiprivkey1qpxprqluxrru5max39nwx6s4hxue4d3n06vv6n7x9dckx9urlquyju0hzgl';
const { secretKey } = decodeSuiPrivateKey(priv);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
console.log(keypair.getPublicKey().toSuiAddress());
