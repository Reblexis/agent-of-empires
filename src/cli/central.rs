//! `aoe central [pause|resume]`: show, pause or resume the central agent's part
//! in aoe. Spec: docs/guides/central-pause.md.

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::session::central::{self, State};

#[derive(Args)]
pub struct CentralArgs {
    #[command(subcommand)]
    pub command: Option<CentralCommand>,
}

#[derive(Subcommand)]
pub enum CentralCommand {
    /// Pause central: run `<app_dir>/central-hooks/paused`, then ignore the
    /// owners file so every session is an ordinary one.
    Pause,
    /// Resume central: run `<app_dir>/central-hooks/running`, then honor the
    /// owners file again.
    Resume,
}

pub fn run(args: CentralArgs) -> Result<()> {
    let state = match args.command {
        Some(CentralCommand::Pause) => {
            central::switch(State::Paused)?;
            State::Paused
        }
        Some(CentralCommand::Resume) => {
            central::switch(State::Running)?;
            State::Running
        }
        None => central::current(),
    };
    println!("{}", state.as_str());
    Ok(())
}
