import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaDex } from "../target/types/solana_dex";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccount,
  getMint,
  getAccount
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";

describe("solana_dex", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaDex as Program<SolanaDex>;
  const wallet = provider.wallet as anchor.Wallet;

  // Create keypairs for test accounts
  const factoryKeypair = anchor.web3.Keypair.generate();
  const lpMintKeypair = anchor.web3.Keypair.generate();
  const token0AccountKeypair = anchor.web3.Keypair.generate();
  const token1AccountKeypair = anchor.web3.Keypair.generate();
  
  let token0: PublicKey;
  let token1: PublicKey;
  let pairAddress: PublicKey;
  let pairBump: number;
  let authorityPDA: PublicKey;
  let authorityBump: number;

  before(async () => {
    // Create two test tokens
    token0 = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      wallet.publicKey,
      6 // decimals
    );

    token1 = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      wallet.publicKey,
      6 // decimals
    );

    // Sort tokens to ensure deterministic pair address
    const [token0Key, token1Key] = token0.toString() < token1.toString() 
      ? [token0, token1] 
      : [token1, token0];

    // Derive pair address
    [pairAddress, pairBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pair"),
        token0Key.toBuffer(),
        token1Key.toBuffer(),
      ],
      program.programId
    );

    // Derive authority PDA
    [authorityPDA, authorityBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("authority"),
        pairAddress.toBuffer(),
      ],
      program.programId
    );

    console.log("Token0:", token0.toString());
    console.log("Token1:", token1.toString());
    console.log("Pair Address:", pairAddress.toString());
    console.log("Authority PDA:", authorityPDA.toString());
  });

  it("Initializes the factory", async () => {
    try {
      const tx = await program.methods
        .initialize()
        .accounts({
          factory: factoryKeypair.publicKey,
          owner: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([factoryKeypair])
        .rpc();
      
      console.log("Factory initialized transaction signature:", tx);

      // Verify the factory was initialized correctly
      const factoryAccount = await program.account.factory.fetch(factoryKeypair.publicKey);
      assert.equal(factoryAccount.owner.toString(), wallet.publicKey.toString());
      assert.equal(factoryAccount.pairCount.toString(), "0");
      assert.equal(factoryAccount.feeOn, false);
    } catch (error) {
      console.error("Error initializing factory:", error);
      throw error;
    }
  });

  it("Creates token accounts", async () => {
    try {
      const tx = await program.methods
        .createTokenAccounts()
        .accounts({
          token0: token0,
          token1: token1,
          pairPda: pairAddress,
          authority: authorityPDA,
          token0Account: token0AccountKeypair.publicKey,
          token1Account: token1AccountKeypair.publicKey,
          sender: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([token0AccountKeypair, token1AccountKeypair])
        .rpc({ commitment: 'confirmed' });
      
      console.log("Token accounts created transaction signature:", tx);

      // Verify token accounts were created correctly
      const token0AccountInfo = await getAccount(provider.connection, token0AccountKeypair.publicKey);
      const token1AccountInfo = await getAccount(provider.connection, token1AccountKeypair.publicKey);
      
      assert.equal(token0AccountInfo.mint.toString(), token0.toString());
      assert.equal(token1AccountInfo.mint.toString(), token1.toString());
      assert.equal(token0AccountInfo.owner.toString(), authorityPDA.toString());
      assert.equal(token1AccountInfo.owner.toString(), authorityPDA.toString());
    } catch (error) {
      console.error("Error creating token accounts:", error);
      throw error;
    }
  });

  it("Creates pair account and LP mint", async () => {
    try {
      const tx = await program.methods
        .createPairAccount()
        .accounts({
          factory: factoryKeypair.publicKey,
          pair: pairAddress,
          token0: token0,
          token1: token1,
          lpMint: lpMintKeypair.publicKey,
          authority: authorityPDA,
          sender: wallet.publicKey,
          owner: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([lpMintKeypair])
        .rpc({ commitment: 'confirmed' });
      
      console.log("Pair account created transaction signature:", tx);

      // Verify the pair account was created
      const pairAccount = await program.account.pairAccount.fetch(pairAddress);
      assert.equal(pairAccount.isInitialized, false);
      
      // Verify LP mint was created correctly
      const lpMintInfo = await getMint(provider.connection, lpMintKeypair.publicKey);
      assert.equal(lpMintInfo.mintAuthority.toString(), authorityPDA.toString());
      assert.equal(lpMintInfo.decimals, 8);
    } catch (error) {
      console.error("Error creating pair account:", error);
      throw error;
    }
  });

  it("Configures the pair", async () => {
    try {
      const tx = await program.methods
        .configurePair()
        .accounts({
          factory: factoryKeypair.publicKey,
          pair: pairAddress,
          token0: token0,
          token1: token1,
          lpMint: lpMintKeypair.publicKey,
          token0Account: token0AccountKeypair.publicKey,
          token1Account: token1AccountKeypair.publicKey,
          sender: wallet.publicKey,
          owner: wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });
      
      console.log("Pair configured transaction signature:", tx);

      // Verify the pair was initialized correctly
      const pairAccount = await program.account.pairAccount.fetch(pairAddress);
      
      assert.equal(pairAccount.factory.toString(), factoryKeypair.publicKey.toString());
      assert.equal(pairAccount.lpMint.toString(), lpMintKeypair.publicKey.toString());
      assert.equal(pairAccount.token0Account.toString(), token0AccountKeypair.publicKey.toString());
      assert.equal(pairAccount.token1Account.toString(), token1AccountKeypair.publicKey.toString());
      assert.equal(pairAccount.reserve0.toString(), "0");
      assert.equal(pairAccount.reserve1.toString(), "0");
      assert.equal(pairAccount.totalSupply.toString(), "0");
      assert.equal(pairAccount.isInitialized, true);
      
      // Check that the factory's pair count was updated
      const factoryAccount = await program.account.factory.fetch(factoryKeypair.publicKey);
      assert.equal(factoryAccount.pairCount.toString(), "1");
      
      // Verify the factory has the correct last pair
      assert.equal(factoryAccount.lastPair.toString(), pairAddress.toString());
    } catch (error) {
      console.error("Error configuring pair:", error);
      throw error;
    }
  });
});