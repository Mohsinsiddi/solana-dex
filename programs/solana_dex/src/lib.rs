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

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount0_desired: u128,
        amount1_desired: u128,
        amount0_min: u128,
        amount1_min: u128,
    ) -> Result<()> {
        // Ensure pair is initialized
        require!(ctx.accounts.pair.is_initialized, DexError::PairNotInitialized);
    
        // Get current reserves
        let reserve0 = ctx.accounts.pair.reserve0;
        let reserve1 = ctx.accounts.pair.reserve1;
        let total_supply = ctx.accounts.pair.total_supply;
    
        // Calculate liquidity amounts
        let (amount0, amount1, liquidity) = if reserve0 == 0 && reserve1 == 0 {
            // First liquidity provision
            // Use the full amounts provided but ensure they don't exceed u64::MAX
            let amount0 = u64::try_from(amount0_desired)
                .map_err(|_| error!(DexError::AmountOverflow))?;
            let amount1 = u64::try_from(amount1_desired)
                .map_err(|_| error!(DexError::AmountOverflow))?;
    
            // Initial liquidity is the geometric mean of the amounts
            let initial_liquidity = sqrt(
                (amount0 as u128).checked_mul(amount1 as u128).unwrap()
            ) as u64;
    
            // Enforce minimum liquidity
            let liquidity = initial_liquidity.checked_sub(1000).unwrap_or(0);
    
            // Minimum liquidity check
            require!(liquidity > 0, DexError::InsufficientLiquidityMinted);
    
            (amount0, amount1, liquidity)
        } else {
            // Not the first provision, calculate based on existing reserves
            let amount1_optimal = amount0_desired
                .checked_mul(reserve1 as u128)
                .unwrap()
                .checked_div(reserve0 as u128)
                .unwrap();
    
            if amount1_optimal <= amount1_desired {
                // amount1_optimal is the binding amount
                require!(
                    amount1_optimal >= amount1_min,
                    DexError::InsufficientAmount
                );
    
                let liquidity = amount0_desired
                    .checked_mul(total_supply as u128)
                    .unwrap()
                    .checked_div(reserve0 as u128)
                    .unwrap();
    
                // Convert to u64 for actual token transfers
                let amount0_u64 = u64::try_from(amount0_desired)
                    .map_err(|_| error!(DexError::AmountOverflow))?;
                let amount1_u64 = u64::try_from(amount1_optimal)
                    .map_err(|_| error!(DexError::AmountOverflow))?;
                let liquidity_u64 = u64::try_from(liquidity)
                    .map_err(|_| error!(DexError::AmountOverflow))?;
    
                (amount0_u64, amount1_u64, liquidity_u64)
            } else {
                // amount0_optimal is the binding amount
                let amount0_optimal = amount1_desired
                    .checked_mul(reserve0 as u128)
                    .unwrap()
                    .checked_div(reserve1 as u128)
                    .unwrap();
    
                require!(
                    amount0_optimal >= amount0_min,
                    DexError::InsufficientAmount
                );
    
                let liquidity = amount1_desired
                    .checked_mul(total_supply as u128)
                    .unwrap()
                    .checked_div(reserve1 as u128)
                    .unwrap();
    
                // Convert to u64 for actual token transfers
                let amount0_u64 = u64::try_from(amount0_optimal)
                    .map_err(|_| error!(DexError::AmountOverflow))?;
                let amount1_u64 = u64::try_from(amount1_desired)
                    .map_err(|_| error!(DexError::AmountOverflow))?;
                let liquidity_u64 = u64::try_from(liquidity)
                    .map_err(|_| error!(DexError::AmountOverflow))?;
    
                (amount0_u64, amount1_u64, liquidity_u64)
            }
        };
    
        // Ensure minimum liquidity amounts
        require!(
            amount0 as u128 >= amount0_min && amount1 as u128 >= amount1_min,
            DexError::InsufficientAmount
        );
    
        // Transfer tokens from user to pair
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token0.to_account_info(),
                    to: ctx.accounts.token0_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount0,
        )?;
    
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token1.to_account_info(),
                    to: ctx.accounts.token1_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount1,
        )?;
        
        // Mint LP tokens to user
        let pair_key = ctx.accounts.pair.key();
        let authority_seeds = &[
            b"authority".as_ref(),
            pair_key.as_ref(),
            &[ctx.accounts.pair.authority_bump],
        ];
    
        // If this is the first deposit, mint minimum liquidity to burn account
        if reserve0 == 0 && reserve1 == 0 {
            // Mint minimum liquidity to burn address
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::MintTo {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        to: ctx.accounts.burn_account.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                    &[authority_seeds],
                ),
                1000, // Minimum liquidity
            )?;
        }
    
        // Mint LP tokens to user
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.liquidity_to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            liquidity,
        )?;
    
        // Update pair account
        ctx.accounts.pair.reserve0 = reserve0.checked_add(amount0).unwrap();
        ctx.accounts.pair.reserve1 = reserve1.checked_add(amount1).unwrap();
        ctx.accounts.pair.total_supply = total_supply.checked_add(liquidity).unwrap();
    
        // If this is the first deposit, add minimum liquidity to total supply
        if reserve0 == 0 && reserve1 == 0 {
            ctx.accounts.pair.total_supply = ctx.accounts.pair.total_supply.checked_add(1000).unwrap();
        }
    
        // Emit event
        emit!(LiquidityAddedEvent {
            sender: ctx.accounts.sender.key(),
            amount0,
            amount1,
            liquidity,
        });
    
        Ok(())
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        liquidity: u128,
        amount0_min: u128,
        amount1_min: u128,
    ) -> Result<()> {
        // Ensure pair is initialized
        require!(ctx.accounts.pair.is_initialized, DexError::PairNotInitialized);
    
        // Get current reserves and total supply
        let reserve0 = ctx.accounts.pair.reserve0;
        let reserve1 = ctx.accounts.pair.reserve1;
        let total_supply = ctx.accounts.pair.total_supply;
    
        // Convert liquidity to u64 since that's what token operations require
        let liquidity_u64 = u64::try_from(liquidity)
            .map_err(|_| error!(DexError::AmountOverflow))?;
    
        // Calculate token amounts based on proportion of liquidity
        let amount0 = liquidity
            .checked_mul(reserve0 as u128)
            .unwrap()
            .checked_div(total_supply as u128)
            .unwrap();
    
        let amount1 = liquidity
            .checked_mul(reserve1 as u128)
            .unwrap()
            .checked_div(total_supply as u128)
            .unwrap();
    
        // Ensure minimum amounts are met
        require!(
            amount0 >= amount0_min && amount1 >= amount1_min,
            DexError::InsufficientAmount
        );
    
        // Convert to u64 for token operations
        let amount0_u64 = u64::try_from(amount0)
            .map_err(|_| error!(DexError::AmountOverflow))?;
        let amount1_u64 = u64::try_from(amount1)
            .map_err(|_| error!(DexError::AmountOverflow))?;
    
        // Burn LP tokens first
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.liquidity_from.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            liquidity_u64,
        )?;
    
        // Transfer tokens to user
        let pair_key = ctx.accounts.pair.key();
        let authority_seeds = &[
            b"authority".as_ref(),
            pair_key.as_ref(),
            &[ctx.accounts.pair.authority_bump],
        ];
    
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.token0_account.to_account_info(),
                    to: ctx.accounts.token0_to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            amount0_u64,
        )?;
    
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.token1_account.to_account_info(),
                    to: ctx.accounts.token1_to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                &[authority_seeds],
            ),
            amount1_u64,
        )?;
    
        // Update pair account
        ctx.accounts.pair.reserve0 = reserve0.checked_sub(amount0_u64).unwrap();
        ctx.accounts.pair.reserve1 = reserve1.checked_sub(amount1_u64).unwrap();
        ctx.accounts.pair.total_supply = total_supply.checked_sub(liquidity_u64).unwrap();
    
        // Emit event
        emit!(LiquidityRemovedEvent {
            sender: ctx.accounts.sender.key(),
            amount0: amount0_u64,
            amount1: amount1_u64,
            liquidity: liquidity_u64,
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
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        mut,
        has_one = owner @ DexError::NotFactoryOwner,
    )]
    pub factory: Account<'info, Factory>,
    
    #[account(
        mut,
        constraint = pair.is_initialized @ DexError::PairNotInitialized,
        constraint = pair.factory == factory.key() @ DexError::InvalidPairFactory,
        constraint = pair.token0_account == token0_account.key() @ DexError::InvalidTokenAccount,
        constraint = pair.token1_account == token1_account.key() @ DexError::InvalidTokenAccount,
        constraint = pair.lp_mint == lp_mint.key() @ DexError::InvalidLpMint,
    )]
    pub pair: Account<'info, PairAccount>,
    
    #[account(mut)]
    pub token0_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub token1_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = user_token0.mint == pair.token0 @ DexError::InvalidTokenAccount,
        constraint = user_token0.owner == sender.key() @ DexError::InvalidTokenOwner,
    )]
    pub user_token0: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = user_token1.mint == pair.token1 @ DexError::InvalidTokenAccount,
        constraint = user_token1.owner == sender.key() @ DexError::InvalidTokenOwner,
    )]
    pub user_token1: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = liquidity_to.mint == lp_mint.key() @ DexError::InvalidTokenAccount,
        constraint = liquidity_to.owner == sender.key() @ DexError::InvalidTokenOwner,
    )]
    pub liquidity_to: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = burn_account.mint == lp_mint.key() @ DexError::InvalidTokenAccount,
    )]
    pub burn_account: Account<'info, TokenAccount>,
    
    /// CHECK: This is the PDA authority for the pair
    #[account(
        seeds = [
            b"authority".as_ref(),
            pair.key().as_ref()
        ],
        bump = pair.authority_bump
    )]
    pub authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub sender: Signer<'info>,
    
    /// CHECK: Factory owner required for authorization
    pub owner: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
}

// Add this event
#[event]
pub struct LiquidityAddedEvent {
    pub sender: Pubkey,
    pub amount0: u64,
    pub amount1: u64,
    pub liquidity: u64,
}

// Add this accounts struct
#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(
        mut,
        has_one = owner @ DexError::NotFactoryOwner,
    )]
    pub factory: Account<'info, Factory>,
    
    #[account(
        mut,
        constraint = pair.is_initialized @ DexError::PairNotInitialized,
        constraint = pair.factory == factory.key() @ DexError::InvalidPairFactory,
        constraint = pair.token0_account == token0_account.key() @ DexError::InvalidTokenAccount,
        constraint = pair.token1_account == token1_account.key() @ DexError::InvalidTokenAccount,
        constraint = pair.lp_mint == lp_mint.key() @ DexError::InvalidLpMint,
    )]
    pub pair: Account<'info, PairAccount>,
    
    #[account(mut)]
    pub token0_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub token1_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = token0_to.mint == pair.token0 @ DexError::InvalidTokenAccount,
        constraint = token0_to.owner == sender.key() @ DexError::InvalidTokenOwner,
    )]
    pub token0_to: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = token1_to.mint == pair.token1 @ DexError::InvalidTokenAccount,
        constraint = token1_to.owner == sender.key() @ DexError::InvalidTokenOwner,
    )]
    pub token1_to: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = liquidity_from.mint == lp_mint.key() @ DexError::InvalidTokenAccount,
        constraint = liquidity_from.owner == sender.key() @ DexError::InvalidTokenOwner,
    )]
    pub liquidity_from: Account<'info, TokenAccount>,
    
    /// CHECK: This is the PDA authority for the pair
    #[account(
        seeds = [
            b"authority".as_ref(),
            pair.key().as_ref()
        ],
        bump = pair.authority_bump
    )]
    pub authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub sender: Signer<'info>,
    
    /// CHECK: Factory owner required for authorization
    pub owner: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
}

// Add this event
#[event]
pub struct LiquidityRemovedEvent {
    pub sender: Pubkey,
    pub amount0: u64,
    pub amount1: u64,
    pub liquidity: u64,
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

    #[msg("Pair is not initialized")]
    PairNotInitialized,
    #[msg("Invalid pair factory")]
    InvalidPairFactory,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Invalid LP mint")]
    InvalidLpMint,
    #[msg("Invalid token owner")]
    InvalidTokenOwner,
    #[msg("Insufficient amount")]
    InsufficientAmount,
    #[msg("Insufficient liquidity minted")]
    InsufficientLiquidityMinted,
    #[msg("Amount exceeds maximum allowable token quantity")]
    AmountOverflow,
}

fn sqrt(value: u128) -> u128 {
    if value < 2 {
        return value;
    }

    let mut x = value / 2;
    let mut y = (x + value / x) / 2;

    while y < x {
        x = y;
        y = (x + value / x) / 2;
    }

    x
}