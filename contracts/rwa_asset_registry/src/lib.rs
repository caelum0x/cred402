//! RWAAssetRegistry (p2 §6.4) — canonical registry of real-world asset
//! references. Mirrors `lib/ledger/contracts/rwa_asset_registry.ts`.

use odra::prelude::*;

#[odra::odra_type]
pub struct RwaAsset {
    pub rwa_id: String,
    /// solar_receivable, trade_invoice, warehouse_inventory, ...
    pub asset_type: String,
    pub issuer: String,
    pub jurisdiction_code: String,
    pub metadata_hash: String,
    pub document_bundle_hash: String,
    /// 0 draft, 1 active, 2 suspended, 3 settled.
    pub status: u8,
    pub created_at: u64,
    pub updated_at: u64,
}

#[odra::event]
pub struct RwaAssetRegistered {
    pub rwa_id: String,
    pub asset_type: String,
    pub jurisdiction_code: String,
}

#[odra::module(events = [RwaAssetRegistered])]
pub struct RWAAssetRegistry {
    assets: Mapping<String, RwaAsset>,
    admin: Var<Address>,
}

#[odra::module]
impl RWAAssetRegistry {
    pub fn init(&mut self) {
        self.admin.set(self.env().caller());
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_asset(
        &mut self,
        rwa_id: String,
        asset_type: String,
        issuer: String,
        jurisdiction_code: String,
        metadata_hash: String,
        document_bundle_hash: String,
    ) {
        if self.assets.get(&rwa_id).is_some() {
            self.env().revert(Error::DuplicateAsset);
        }
        let now = self.env().get_block_time();
        let asset = RwaAsset {
            rwa_id: rwa_id.clone(),
            asset_type: asset_type.clone(),
            issuer,
            jurisdiction_code: jurisdiction_code.clone(),
            metadata_hash,
            document_bundle_hash,
            status: 1,
            created_at: now,
            updated_at: now,
        };
        self.assets.set(&rwa_id, asset);
        self.env().emit_event(RwaAssetRegistered {
            rwa_id,
            asset_type,
            jurisdiction_code,
        });
    }

    pub fn set_status(&mut self, rwa_id: String, status: u8) {
        self.only_admin();
        let mut a = self
            .assets
            .get(&rwa_id)
            .unwrap_or_revert_with(&self.env(), Error::UnknownAsset);
        a.status = status;
        a.updated_at = self.env().get_block_time();
        self.assets.set(&rwa_id, a);
    }

    pub fn get_asset(&self, rwa_id: String) -> Option<RwaAsset> {
        self.assets.get(&rwa_id)
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    DuplicateAsset = 1,
    UnknownAsset = 2,
    Unauthorized = 3,
    NotInitialized = 4,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, RWAAssetRegistryHostRef) {
        let env = odra_test::env();
        let reg = RWAAssetRegistry::deploy(&env, NoArgs);
        (env, reg)
    }

    fn register(reg: &mut RWAAssetRegistryHostRef, id: &str) {
        reg.register_asset(
            id.to_string(),
            "solar_receivable".to_string(),
            "SPV-A17".to_string(),
            "TR".to_string(),
            "0xmeta".to_string(),
            "0xdocs".to_string(),
        );
    }

    #[test]
    fn registers_an_active_asset() {
        let (_env, mut reg) = deploy();
        register(&mut reg, "SOLAR-A17");
        let a = reg.get_asset("SOLAR-A17".to_string()).unwrap();
        assert_eq!(a.asset_type, "solar_receivable");
        assert_eq!(a.jurisdiction_code, "TR");
        assert_eq!(a.status, 1);
    }

    #[test]
    fn rejects_duplicate_asset() {
        let (_env, mut reg) = deploy();
        register(&mut reg, "SOLAR-A17");
        let dup = reg.try_register_asset(
            "SOLAR-A17".to_string(),
            "x".to_string(),
            "y".to_string(),
            "TR".to_string(),
            "0x".to_string(),
            "0x".to_string(),
        );
        assert!(dup.is_err());
    }

    #[test]
    fn admin_can_update_status() {
        let (_env, mut reg) = deploy();
        register(&mut reg, "SOLAR-A17");
        reg.set_status("SOLAR-A17".to_string(), 3 /* settled */);
        assert_eq!(reg.get_asset("SOLAR-A17".to_string()).unwrap().status, 3);
    }
}
