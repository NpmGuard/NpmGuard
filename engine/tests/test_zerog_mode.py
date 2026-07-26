"""The unified 0G flag is strict in production and composable in development."""

import pydantic
import pytest

from npmguard.config import Settings

FAKE_KEY = "0x" + "11" * 32
CONTRACT = "0x" + "22" * 20


def test_production_mode_refuses_a_partial_zerog_stack() -> None:
    with pytest.raises(pydantic.ValidationError, match="ZEROG_RELAYER_KEY"):
        Settings(
            _env_file=None,
            env="prod",
            zerog_enabled=True,
            mock_llm=True,
            payment_required=False,
        )


def test_production_mode_requires_the_selected_payment_contract() -> None:
    with pytest.raises(pydantic.ValidationError, match="ZEROG_TESTNET_CONTRACT"):
        Settings(
            _env_file=None,
            env="prod",
            zerog_enabled=True,
            mock_llm=True,
            zerog_relayer_key=FAKE_KEY,
            payment_required=True,
        )


def test_production_mode_accepts_a_complete_non_world_stack() -> None:
    settings = Settings(
        _env_file=None,
        env="prod",
        zerog_enabled=True,
        mock_llm=True,
        zerog_relayer_key=FAKE_KEY,
        zerog_testnet_contract=CONTRACT,
    )
    assert settings.zerog_chain_name == "0g-testnet"
    assert settings.zerog_storage_enabled


def test_master_mode_overrides_an_incomplete_generic_compute_backend() -> None:
    settings = Settings(
        _env_file=None,
        zerog_enabled=True,
        llm_backend="openai_compatible",
        llm_base_url=None,
    )
    assert settings.zerog_router_url == "https://router-api.0g.ai/v1"


def test_world_flow_requires_the_attestation_registry_in_production() -> None:
    with pytest.raises(pydantic.ValidationError, match="ZEROG_ATTESTATIONS_CONTRACT"):
        Settings(
            _env_file=None,
            env="prod",
            zerog_enabled=True,
            mock_llm=True,
            payment_required=False,
            zerog_relayer_key=FAKE_KEY,
            world_app_id="app",
            world_rp_id="rp",
            world_signing_key="11" * 32,
        )
