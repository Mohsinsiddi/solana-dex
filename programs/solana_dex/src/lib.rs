use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("FhkrUwK9TuEqsRirvfD442i5K5rjLmZzPK74ogikTBAS"); // Replace with your actual program ID

#[program]
pub mod solana_dex {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        factory.owner = ctx.accounts.owner.key();
        factory.pair_count = 0;
        factory.fee_to = Pubkey::default();
        factory.fee_on = false;
        factory.last_pair = Pubkey::default();
        Ok(())
    }

    // Step 1: Create token accounts only
    pub fn create_token_accounts(ctx: Context<CreateTokenAccounts>) -> Result<()> {
        // Ensure token0 and token1 are different
        require!(
            ctx.accounts.token0.key() != ctx.accounts.token1.key(),
            DexError::IdenticalTokens
        );

        // Nothing else to do, accounts are initialized via the context
        Ok(())
    }

    // Step 2: Create pair account and LP mint
    pub fn create_pair_account(ctx: Context<CreatePairAccount>) -> Result<()> {
        let pair = &mut ctx.accounts.pair;
        pair.bump = ctx.bumps.pair;
        pair.authority_bump = ctx.bumps.authority;
        
        // Mark as initialized but not yet configured
        pair.is_initialized = false;

        Ok(())
    }

    // Step 3: Configure the pair with actual data
    pub fn configure_pair(ctx: Context<ConfigurePair>) -> Result<()> {
        // Ensure the pair is not already initialized
        require!(!ctx.accounts.pair.is_initialized, DexError::PairAlreadyInitialized);

        // Determine which token is token0 and which is token1
        let (token0, token1) = if ctx.accounts.token0.key() < ctx.accounts.token1.key() {
            (ctx.accounts.token0.key(), ctx.accounts.token1.key())
        } else {
            (ctx.accounts.token1.key(), ctx.accounts.token0.key())
        };

        // Initialize the pair account
        let pair = &mut ctx.accounts.pair;
        pair.factory = ctx.accounts.factory.key();
        pair.token0 = token0;
        pair.token1 = token1;
        pair.reserve0 = 0;
        pair.reserve1 = 0;
        pair.token0_account = ctx.accounts.token0_account.key();
        pair.token1_account = ctx.accounts.token1_account.key();
        pair.lp_mint = ctx.accounts.lp_mint.key();
        pair.total_supply = 0;
        pair.is_initialized = true;

        // Update the factory with the new pair
        let factory = &mut ctx.accounts.factory;
        factory.last_pair = ctx.accounts.pair.key();
        factory.pair_count += 1;

        // Emit an event for pair creation
        emit!(PairCreatedEvent {
            token0,
            token1,
            pair: ctx.accounts.pair.key(),
            pair_count: factory.pair_count,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = Factory::LEN
    )]
    pub factory: Account<'info, Factory>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// Step 1: Create token accounts only
#[derive(Accounts)]
pub struct CreateTokenAccounts<'info> {
    // Remove the factory to save stack space
    
    /// CHECK: This is a token mint
    pub token0: UncheckedAccount<'info>,
    
    /// CHECK: This is a token mint
    pub token1: UncheckedAccount<'info>,
    
    /// CHECK: This is the authority PDA
    #[account(
        seeds = [
            b"authority".as_ref(),
            pair_pda.key().as_ref()
        ],
        bump
    )]
    pub authority: UncheckedAccount<'info>,
    
    /// CHECK: This is a PDA for the pair, used only for the authority derivation
    #[account(
        seeds = [
            b"pair".as_ref(),
            token0.key().as_ref(),
            token1.key().as_ref()
        ],
        bump
    )]
    pub pair_pda: UncheckedAccount<'info>,
    
    #[account(
        init,
        payer = sender,
        token::mint = token0,
        token::authority = authority,
    )]
    pub token0_account: Account<'info, TokenAccount>,
    
    #[account(
        init,
        payer = sender,
        token::mint = token1,
        token::authority = authority,
    )]
    pub token1_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub sender: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// Step 2: Create pair account and LP mint
#[derive(Accounts)]
pub struct CreatePairAccount<'info> {
    #[account(
        mut,
        has_one = owner @ DexError::NotFactoryOwner,
    )]
    pub factory: Account<'info, Factory>,
    
    #[account(
        init,
        payer = sender,
        space = PairAccount::LEN,
        seeds = [
            b"pair".as_ref(),
            token0.key().as_ref(),
            token1.key().as_ref()
        ],
        bump
    )]
    pub pair: Account<'info, PairAccount>,
    
    /// CHECK: This is a token mint and is validated by the token program
    pub token0: Account<'info, Mint>,
    
    /// CHECK: This is a token mint and is validated by the token program
    pub token1: Account<'info, Mint>,
    
    #[account(
        init,
        payer = sender,
        mint::decimals = 8,
        mint::authority = authority,
    )]
    pub lp_mint: Account<'info, Mint>,
    
    /// CHECK: This is the PDA authority for the pair
    #[account(
        seeds = [
            b"authority".as_ref(),
            pair.key().as_ref()
        ],
        bump
    )]
    pub authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub sender: Signer<'info>,
    
    /// CHECK: Factory owner required for authorization
    pub owner: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// Step 3: Configure the pair
#[derive(Accounts)]
pub struct ConfigurePair<'info> {
    #[account(
        mut,
        has_one = owner @ DexError::NotFactoryOwner,
    )]
    pub factory: Account<'info, Factory>,
    
    #[account(mut)]
    pub pair: Account<'info, PairAccount>,
    
    /// CHECK: This is a token mint
    pub token0: UncheckedAccount<'info>,
    
    /// CHECK: This is a token mint
    pub token1: UncheckedAccount<'info>,
    
    pub lp_mint: Account<'info, Mint>,
    
    pub token0_account: Account<'info, TokenAccount>,
    
    pub token1_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub sender: Signer<'info>,
    
    /// CHECK: Factory owner required for authorization
    pub owner: UncheckedAccount<'info>,
}

#[account]
pub struct Factory {
    pub owner: Pubkey,
    pub pair_count: u64,
    pub fee_to: Pubkey,
    pub fee_on: bool,
    pub last_pair: Pubkey,
}

impl Factory {
    pub const LEN: usize = 8 + // discriminator
        32 + // owner pubkey
        8 + // pair_count
        32 + // fee_to pubkey
        1 + // fee_on boolean
        32; // last_pair pubkey
}

#[account]
pub struct PairAccount {
    pub factory: Pubkey,
    pub token0: Pubkey,
    pub token1: Pubkey,
    pub reserve0: u64,
    pub reserve1: u64,
    pub token0_account: Pubkey,
    pub token1_account: Pubkey,
    pub lp_mint: Pubkey,
    pub total_supply: u64,
    pub bump: u8,
    pub authority_bump: u8,
    pub is_initialized: bool,
}

impl PairAccount {
    pub const LEN: usize = 8 + // discriminator
        32 + // factory
        32 + // token0
        32 + // token1
        8 + // reserve0
        8 + // reserve1
        32 + // token0_account
        32 + // token1_account
        32 + // lp_mint
        8 + // total_supply
        1 + // bump
        1 + // authority_bump
        1; // is_initialized
}

#[event]
pub struct PairCreatedEvent {
    pub token0: Pubkey,
    pub token1: Pubkey,
    pub pair: Pubkey,
    pub pair_count: u64,
}

#[error_code]
pub enum DexError {
    #[msg("Tokens cannot be identical")]
    IdenticalTokens,
    #[msg("Pair already exists for these tokens")]
    PairExists,
    #[msg("Only the factory owner can perform this action")]
    NotFactoryOwner,
    #[msg("Pair is already initialized")]
    PairAlreadyInitialized,
}