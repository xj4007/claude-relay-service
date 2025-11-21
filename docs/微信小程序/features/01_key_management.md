# Feature: Key Management

## Goal
Allow users to manage API Keys (Add, Remove, Select) locally without login.

## Details
- **Storage**: Use `uni.setStorageSync` to store keys array.
- **Validation**: Mock validation API. Input must start with `cr_`.
- **UI**:
    - Empty state: Prompt to add key.
    - Add Key: Input field + "Validate & Add" button.
    - Key List: Dropdown/Sheet to switch keys.
    - Key Info: Show current key details (masked).

## Progress
- [ ] Define Key interface
- [ ] Implement Key Store (Pinia)
- [ ] Create Key Management Page
- [ ] Create Key Selector Component
