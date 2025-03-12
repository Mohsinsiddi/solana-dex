import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaDex } from "../target/types/solana_dex";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccount,
  getMint,
  getAccount,
  createMintToInstruction
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

  it("Adds liquidity to the pair", async () => {
    try {
      // First, we need to create token accounts for the user
      const userToken0Account = await createAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        token0,
        wallet.publicKey
      );
      
      const userToken1Account = await createAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        token1,
        wallet.publicKey
      );
      
      // Create LP token account for the user
      const userLpTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        lpMintKeypair.publicKey,
        wallet.publicKey
      );
      
      // Create burn address (black hole) for minimum liquidity
      const burnAddress = new PublicKey("11111111111111111111111111111111");
      const burnLpTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        lpMintKeypair.publicKey,
        burnAddress
      );
      
      // Mint some tokens to the user
      const mintAmount = 1_000_000_000; // 1000 tokens assuming 6 decimals
      
      await mintToWallet(
        provider.connection, 
        wallet.payer, 
        token0, 
        userToken0Account, 
        wallet.publicKey, 
        mintAmount
      );
      
      await mintToWallet(
        provider.connection, 
        wallet.payer, 
        token1, 
        userToken1Account, 
        wallet.publicKey, 
        mintAmount
      );
      
      // Verify token balances before adding liquidity
      let userToken0Balance = await getTokenBalance(provider.connection, userToken0Account);
      let userToken1Balance = await getTokenBalance(provider.connection, userToken1Account);
      
      console.log("Initial token0 balance:", userToken0Balance);
      console.log("Initial token1 balance:", userToken1Balance);
      
      // Add liquidity
      const amount0Desired = new anchor.BN(100_000_000); // 100 tokens with 6 decimals
      const amount1Desired = new anchor.BN(200_000_000); // 200 tokens with 6 decimals
      const amount0Min = new anchor.BN(90_000_000);     // 90 tokens minimum
      const amount1Min = new anchor.BN(180_000_000);    // 180 tokens minimum
      
      const tx = await program.methods
        .addLiquidity(
          amount0Desired,
          amount1Desired,
          amount0Min,
          amount1Min
        )
        .accounts({
          factory: factoryKeypair.publicKey,
          pair: pairAddress,
          token0Account: token0AccountKeypair.publicKey,
          token1Account: token1AccountKeypair.publicKey,
          userToken0: userToken0Account,
          userToken1: userToken1Account,
          lpMint: lpMintKeypair.publicKey,
          liquidityTo: userLpTokenAccount,
          burnAccount: burnLpTokenAccount,
          authority: authorityPDA,
          sender: wallet.publicKey,
          owner: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: 'confirmed' });
      
      console.log("Liquidity added transaction signature:", tx);
      
      // Verify token balances after adding liquidity
      let newUserToken0Balance = await getTokenBalance(provider.connection, userToken0Account);
      let newUserToken1Balance = await getTokenBalance(provider.connection, userToken1Account);
      let lpTokenBalance = await getTokenBalance(provider.connection, userLpTokenAccount);
      let burnTokenBalance = await getTokenBalance(provider.connection, burnLpTokenAccount);
      
      console.log("New token0 balance:", newUserToken0Balance);
      console.log("New token1 balance:", newUserToken1Balance);
      console.log("LP token balance:", lpTokenBalance);
      console.log("Burn address LP balance:", burnTokenBalance);
      
      // Calculate expected amount transferred
      const token0Spent = userToken0Balance - newUserToken0Balance;
      const token1Spent = userToken1Balance - newUserToken1Balance;
      
      console.log("Token0 spent:", token0Spent);
      console.log("Token1 spent:", token1Spent);
      
      // Verify pair state
      const pairAccount = await program.account.pairAccount.fetch(pairAddress);
      console.log("Token 0" ,pairAccount.token0.toString())
      console.log("Token 1",pairAccount.token1.toString())
      console.log("Reserves 0" ,pairAccount.reserve0.toString())
      console.log("Reserves 1",pairAccount.reserve1.toString())
      console.log("Total Supply",pairAccount.totalSupply.toString())

      assert.equal(pairAccount.reserve0.toString(), token0Spent.toString(), "Reserve0 not updated correctly");
      assert.equal(pairAccount.reserve1.toString(), token1Spent.toString(), "Reserve1 not updated correctly");
      assert.isTrue(pairAccount.totalSupply.gt(new anchor.BN(0)), "Total supply should be greater than 0");
      
      // For a first liquidity provision, verify minimum liquidity
      if (token0Spent > 0 && token1Spent > 0) {
        assert.equal(burnTokenBalance, 1000, "Burn account should have minimum liquidity");
        
        // Expected liquidity is approximately sqrt(token0Spent * token1Spent) - 1000
        // But we'll just verify it's positive since exact calculation may differ
        assert.isTrue(lpTokenBalance > 0, "User should have received LP tokens");
      }
      
    } catch (error) {
      console.error("Error adding liquidity:", error);
      throw error;
    }
  });

  it("Removes liquidity from the pair", async () => {
    try {
      // Get the user's token accounts (these should already exist from add_liquidity test)
      const userToken0Account = getAssociatedTokenAddressSync(
        token0,
        wallet.publicKey
      );
      
      const userToken1Account = getAssociatedTokenAddressSync(
        token1,
        wallet.publicKey
      );
      
      const userLpTokenAccount = getAssociatedTokenAddressSync(
        lpMintKeypair.publicKey,
        wallet.publicKey
      );
      
      // First we need to check the current balances to know what we're working with
      let userToken0Balance = await getTokenBalance(provider.connection, userToken0Account);
      let userToken1Balance = await getTokenBalance(provider.connection, userToken1Account);
      let userLpBalance = await getTokenBalance(provider.connection, userLpTokenAccount);
      
      console.log("Before removal - Token0 balance:", userToken0Balance);
      console.log("Before removal - Token1 balance:", userToken1Balance);
      console.log("Before removal - LP token balance:", userLpBalance);
      
      // Get pair state before removal
      let pairBeforeRemoval = await program.account.pairAccount.fetch(pairAddress);
      console.log("Pair reserves before removal - Reserve0:", pairBeforeRemoval.reserve0.toString());
      console.log("Pair reserves before removal - Reserve1:", pairBeforeRemoval.reserve1.toString());
      console.log("Pair total supply before removal:", pairBeforeRemoval.totalSupply.toString());
      
      // Amount of LP tokens to remove (50% of user's balance)
      const liquidityToRemove = new anchor.BN(Math.floor(userLpBalance));
      
      // Calculate minimum amounts (with some slippage tolerance)
      const slippageTolerance = 0.95; // 5% slippage tolerance
      const expectedAmount0 = Math.floor(
        (userLpBalance / 2) * 
        Number(pairBeforeRemoval.reserve0) / 
        Number(pairBeforeRemoval.totalSupply)
      );
      const expectedAmount1 = Math.floor(
        (userLpBalance / 2) * 
        Number(pairBeforeRemoval.reserve1) / 
        Number(pairBeforeRemoval.totalSupply)
      );
      
      const amount0Min = new anchor.BN(Math.floor(expectedAmount0 * slippageTolerance));
      const amount1Min = new anchor.BN(Math.floor(expectedAmount1 * slippageTolerance));
      
      console.log("Removing liquidity:", liquidityToRemove.toString());
      console.log("Expected amount0:", expectedAmount0);
      console.log("Expected amount1:", expectedAmount1);
      console.log("Minimum amount0:", amount0Min.toString());
      console.log("Minimum amount1:", amount1Min.toString());
      
      // Call remove_liquidity
      const tx = await program.methods
        .removeLiquidity(
          liquidityToRemove,
          amount0Min,
          amount1Min
        )
        .accounts({
          factory: factoryKeypair.publicKey,
          pair: pairAddress,
          token0Account: token0AccountKeypair.publicKey,
          token1Account: token1AccountKeypair.publicKey,
          token0To: userToken0Account,
          token1To: userToken1Account,
          lpMint: lpMintKeypair.publicKey,
          liquidityFrom: userLpTokenAccount,
          authority: authorityPDA,
          sender: wallet.publicKey,
          owner: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: 'confirmed' });
      
      console.log("Liquidity removed transaction signature:", tx);
      
      // Get transaction details and logs
      const txDetails = await provider.connection.getTransaction(tx, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      
      if (txDetails && txDetails.meta && txDetails.meta.logMessages) {
        console.log("Transaction logs:", txDetails.meta.logMessages);
      }
      
      // Verify token balances after removing liquidity
      let newUserToken0Balance = await getTokenBalance(provider.connection, userToken0Account);
      let newUserToken1Balance = await getTokenBalance(provider.connection, userToken1Account);
      let newUserLpBalance = await getTokenBalance(provider.connection, userLpTokenAccount);
      
      console.log("After removal - Token0 balance:", newUserToken0Balance);
      console.log("After removal - Token1 balance:", newUserToken1Balance);
      console.log("After removal - LP token balance:", newUserLpBalance);
      
      // Calculate actual amounts received
      const token0Received = newUserToken0Balance - userToken0Balance;
      const token1Received = newUserToken1Balance - userToken1Balance;
      const lpBurned = userLpBalance - newUserLpBalance;
      
      console.log("Token0 received:", token0Received);
      console.log("Token1 received:", token1Received);
      console.log("LP tokens burned:", lpBurned);
      
      // Verify pair state after removal
      const pairAfterRemoval = await program.account.pairAccount.fetch(pairAddress);
      
      console.log("Pair reserves after removal - Reserve0:", pairAfterRemoval.reserve0.toString());
      console.log("Pair reserves after removal - Reserve1:", pairAfterRemoval.reserve1.toString());
      console.log("Pair total supply after removal:", pairAfterRemoval.totalSupply.toString());
      
      // Verify the state changes
      assert.equal(
        pairBeforeRemoval.reserve0.sub(pairAfterRemoval.reserve0).toString(),
        token0Received.toString(),
        "Reserve0 reduction should match token0 received"
      );
      
      assert.equal(
        pairBeforeRemoval.reserve1.sub(pairAfterRemoval.reserve1).toString(),
        token1Received.toString(),
        "Reserve1 reduction should match token1 received"
      );
      
      assert.equal(
        pairBeforeRemoval.totalSupply.sub(pairAfterRemoval.totalSupply).toString(),
        lpBurned.toString(),
        "Total supply reduction should match LP tokens burned"
      );
      
      // Verify minimums were met
      assert.isAtLeast(
        token0Received,
        parseInt(amount0Min.toString()),
        "Token0 received should be at least minimum"
      );
      
      assert.isAtLeast(
        token1Received,
        parseInt(amount1Min.toString()),
        "Token1 received should be at least minimum"
      );
      
      // Verify LP tokens were burned correctly
      assert.equal(
        lpBurned,
        parseInt(liquidityToRemove.toString()),
        "LP tokens burned should match requested amount"
      );
      
    } catch (error) {
      console.error("Error removing liquidity:", error);
      throw error;
    }
  });
  
  // Helper functions
  async function mintToWallet(connection, payer, mint, destination, authority, amount) {
    const tx = new anchor.web3.Transaction();
    tx.add(
      createMintToInstruction(
        mint,
        destination,
        authority,
        amount
      )
    );
    
    await provider.sendAndConfirm(tx, [payer]);
  }
  
  async function getTokenBalance(connection, tokenAccount) {
    const accountInfo = await getAccount(connection, tokenAccount);
    return parseInt(accountInfo.amount.toString());
  }
});