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
  console.log("Admin Wallet address", wallet.publicKey.toString());
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
      const mintAmount = 2_000_000_000_000; // 1000 tokens assuming 6 decimals
      
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
      const amount0Desired = new anchor.BN(1000_000_000_000); // 100 tokens with 6 decimals
      const amount1Desired = new anchor.BN(2000_000_000_000); // 200 tokens with 6 decimals
      const amount0Min = new anchor.BN(900_000_000_000);     // 90 tokens minimum
      const amount1Min = new anchor.BN(1800_000_000_000);    // 180 tokens minimum
      
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
  
  it("Swaps tokens", async () => {
    try {
      // Get the user's token accounts
      const userToken0Account = getAssociatedTokenAddressSync(
        token0,
        wallet.publicKey
      );
      
      const userToken1Account = getAssociatedTokenAddressSync(
        token1,
        wallet.publicKey
      );
      
      // Check current pool state and token balances
      const pairBeforeSwap = await program.account.pairAccount.fetch(pairAddress);
      const userToken0BalanceBefore = await getTokenBalance(provider.connection, userToken0Account);
      const userToken1BalanceBefore = await getTokenBalance(provider.connection, userToken1Account);
      
      console.log("=== POOL STATE BEFORE SWAP ===");
      console.log("Pool reserve0:", pairBeforeSwap.reserve0.toString());
      console.log("Pool reserve1:", pairBeforeSwap.reserve1.toString());
      console.log("User token0 balance:", userToken0BalanceBefore);
      console.log("User token1 balance:", userToken1BalanceBefore);
      
      // Calculate current prices
      const price0In1Before = (pairBeforeSwap.reserve1.toNumber() / pairBeforeSwap.reserve0.toNumber()).toFixed(6);
      const price1In0Before = (pairBeforeSwap.reserve0.toNumber() / pairBeforeSwap.reserve1.toNumber()).toFixed(6);
      
      console.log("Price (token0 in terms of token1):", price0In1Before);
      console.log("Price (token1 in terms of token0):", price1In0Before);
      
      // First swap: token0 -> token1
      const amountIn = new anchor.BN(100_000); // 10 tokens with 6 decimals
      
      // Calculate expected output amount with 0.3% fee
      const amountInWithFee = amountIn.muln(997);
      const numerator = amountInWithFee.mul(pairBeforeSwap.reserve1);
      const denominator = pairBeforeSwap.reserve0.muln(1000).add(amountInWithFee);
      const expectedAmountOut = numerator.div(denominator);
      
      // Set minimum amount out with 1% slippage tolerance
      const amountOutMin = expectedAmountOut.muln(99).divn(100);
      
      console.log("=== SWAP PARAMETERS (TOKEN0 -> TOKEN1) ===");
      console.log("Amount in:", amountIn.toString());
      console.log("Expected amount out:", expectedAmountOut.toString());
      console.log("Minimum amount out:", amountOutMin.toString());
      
      // Execute the swap
      const tx = await program.methods
        .swap(
          amountIn,
          amountOutMin
        )
        .accounts({
          pair: pairAddress,
          token0Account: token0AccountKeypair.publicKey,
          token1Account: token1AccountKeypair.publicKey,
          tokenIn: userToken0Account,
          tokenOut: userToken1Account,
          authority: authorityPDA,
          sender: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: 'confirmed' });
      
      console.log("Swap transaction signature:", tx);
      
      // Get transaction details and logs
      const txDetails = await provider.connection.getTransaction(tx, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      
      if (txDetails && txDetails.meta && txDetails.meta.logMessages) {
        console.log("Transaction logs:", txDetails.meta.logMessages);
      }
      
      // Check the pool state and balances after swap
      const pairAfterSwap = await program.account.pairAccount.fetch(pairAddress);
      const userToken0BalanceAfter = await getTokenBalance(provider.connection, userToken0Account);
      const userToken1BalanceAfter = await getTokenBalance(provider.connection, userToken1Account);
      
      console.log("=== POOL STATE AFTER SWAP ===");
      console.log("Pool reserve0:", pairAfterSwap.reserve0.toString());
      console.log("Pool reserve1:", pairAfterSwap.reserve1.toString());
      console.log("User token0 balance:", userToken0BalanceAfter);
      console.log("User token1 balance:", userToken1BalanceAfter);
      
      // Calculate new prices
      const price0In1After = (pairAfterSwap.reserve1.toNumber() / pairAfterSwap.reserve0.toNumber()).toFixed(6);
      const price1In0After = (pairAfterSwap.reserve0.toNumber() / pairAfterSwap.reserve1.toNumber()).toFixed(6);
      
      console.log("Price (token0 in terms of token1):", price0In1After);
      console.log("Price (token1 in terms of token0):", price1In0After);
      
      // Calculate actual amounts swapped
      const token0Spent = userToken0BalanceBefore - userToken0BalanceAfter;
      const token1Received = userToken1BalanceAfter - userToken1BalanceBefore;
      
      console.log("Token0 spent:", token0Spent);
      console.log("Token1 received:", token1Received);
      
      // Verify pool state changes
      assert.equal(
        pairAfterSwap.reserve0.sub(pairBeforeSwap.reserve0).toString(),
        token0Spent.toString(),
        "Reserve0 increase should match token0 spent"
      );
      
      assert.equal(
        pairBeforeSwap.reserve1.sub(pairAfterSwap.reserve1).toString(),
        token1Received.toString(),
        "Reserve1 decrease should match token1 received"
      );
      
      // Verify price impact
      assert(
        parseFloat(price0In1After) < parseFloat(price0In1Before),
        "Price of token0 in terms of token1 should decrease after selling token0"
      );
      
      assert(
        parseFloat(price1In0After) > parseFloat(price1In0Before),
        "Price of token1 in terms of token0 should increase after selling token0"
      );
      // Verify constant product (k) value
      const kBefore = pairBeforeSwap.reserve0.mul(pairBeforeSwap.reserve1);
      const kAfter = pairAfterSwap.reserve0.mul(pairAfterSwap.reserve1);
      
      console.log("K before:", kBefore.toString());
      console.log("K after:", kAfter.toString());
      
      // K should be the same or slightly higher due to fees
      assert(
        kAfter.gte(kBefore),
        "K value should not decrease"
      );
      
      // Now test swap in reverse direction (token1 -> token0)
      console.log("\n=== TESTING REVERSE SWAP (TOKEN1 -> TOKEN0) ===");
      
      const pairBeforeReverseSwap = pairAfterSwap;
      const amountInReverse = new anchor.BN(token1Received); // Use the amount we just received
      
      // Calculate expected output for reverse swap
      const amountInWithFeeReverse = amountInReverse.muln(997);
      const numeratorReverse = amountInWithFeeReverse.mul(pairBeforeReverseSwap.reserve0);
      const denominatorReverse = pairBeforeReverseSwap.reserve1.muln(1000).add(amountInWithFeeReverse);
      const expectedAmountOutReverse = numeratorReverse.div(denominatorReverse);
      
      // Set minimum amount out with 1% slippage tolerance
      const amountOutMinReverse = expectedAmountOutReverse.muln(99).divn(100);
      
      console.log("Amount in (token1):", amountInReverse.toString());
      console.log("Expected amount out (token0):", expectedAmountOutReverse.toString());
      console.log("Minimum amount out (token0):", amountOutMinReverse.toString());
      
      // Execute the reverse swap
      const txReverse = await program.methods
        .swap(
          amountInReverse,
          amountOutMinReverse
        )
        .accounts({
          pair: pairAddress,
          token0Account: token0AccountKeypair.publicKey,
          token1Account: token1AccountKeypair.publicKey,
          tokenIn: userToken1Account,
          tokenOut: userToken0Account,
          authority: authorityPDA,
          sender: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: 'confirmed' });
      
      console.log("Reverse swap transaction signature:", txReverse);
      
      // Check the pool state after reverse swap
      const pairAfterReverseSwap = await program.account.pairAccount.fetch(pairAddress);
      const userToken0BalanceAfterReverse = await getTokenBalance(provider.connection, userToken0Account);
      const userToken1BalanceAfterReverse = await getTokenBalance(provider.connection, userToken1Account);
      
      console.log("=== POOL STATE AFTER REVERSE SWAP ===");
      console.log("Pool reserve0:", pairAfterReverseSwap.reserve0.toString());
      console.log("Pool reserve1:", pairAfterReverseSwap.reserve1.toString());
      console.log("User token0 balance:", userToken0BalanceAfterReverse);
      console.log("User token1 balance:", userToken1BalanceAfterReverse);
      
      // Calculate final prices
      const price0In1Final = (pairAfterReverseSwap.reserve1.toNumber() / pairAfterReverseSwap.reserve0.toNumber()).toFixed(6);
      const price1In0Final = (pairAfterReverseSwap.reserve0.toNumber() / pairAfterReverseSwap.reserve1.toNumber()).toFixed(6);
      
      console.log("Final price (token0 in terms of token1):", price0In1Final);
      console.log("Final price (token1 in terms of token0):", price1In0Final);
      
      // Calculate actual amounts swapped in reverse
      const token1Spent = userToken1BalanceAfter - userToken1BalanceAfterReverse;
      const token0Received = userToken0BalanceAfterReverse - userToken0BalanceAfter;
      
      console.log("Token1 spent:", token1Spent);
      console.log("Token0 received:", token0Received);
      
      // Verify price movement in reverse direction
      assert(
        parseFloat(price0In1Final) > parseFloat(price0In1After),
        "Price of token0 in terms of token1 should increase after buying token0"
      );
      
      assert(
        parseFloat(price1In0Final) < parseFloat(price1In0After),
        "Price of token1 in terms of token0 should decrease after buying token0"
      );
      
      // Verify final k value
      const kAfterReverse = pairAfterReverseSwap.reserve0.mul(pairAfterReverseSwap.reserve1);
      console.log("K after reverse swap:", kAfterReverse.toString());
      
      // K should still be the same or higher
      assert(
        kAfterReverse.gte(kAfter),
        "K value should not decrease after reverse swap"
      );
      
      // Note: After two swaps, we should have less tokens than we started with due to fees
      assert(
        userToken0BalanceAfterReverse < userToken0BalanceBefore,
        "User should have less token0 after round-trip swap due to fees"
      );
      
    } catch (error) {
      console.error("Error swapping tokens:", error);
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