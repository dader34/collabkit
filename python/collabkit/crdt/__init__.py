"""
CRDT (Conflict-free Replicated Data Types) module.

Provides data structures that can be replicated across multiple nodes
and merged automatically without conflicts.
"""

from .base import (
    CRDT,
    Operation,
    StateCRDT,
    VersionVector,
)
from .register import LWWRegister
from .map import LWWMap
from .counter import GCounter, PNCounter
from .set import ORSet

__all__ = [
    # Base classes
    "CRDT",
    "Operation",
    "StateCRDT",
    "VersionVector",
    # CRDT types
    "LWWRegister",
    "LWWMap",
    "GCounter",
    "PNCounter",
    "ORSet",
]
