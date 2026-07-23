// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

contract Banner is AccessControlUpgradeable {
    struct Feature {
        string name;
        string description;
        string cta;
        string ctaLink;
    }

    struct BannerData {
        string heading;
        string subtitle;
        Feature[3] features;
    }

    bytes32 public constant OPERATOR = keccak256("OPERATOR");

    enum BannerType {
        LEGACY,
        TIMELOCK
    }

    mapping(BannerType => BannerData) private banners;

    uint16[3] public NAME_MAX;
    uint16[3] public DESC_MAX;
    uint16[3] public CTA_MAX;
    uint16[3] public CTA_LINK_MAX;


    event BannerInfoUpdated(string bannerType, string heading, string subtitle);
    event FeatureUpdated(
        string bannerType,
        uint8 featureIndex,
        string name,
        string description,
        string cta,
        string ctaLink
    );

    error InvalidLength(string str, uint256 minLength, uint256 maxLength);

    function initialize() public initializer {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR, msg.sender);
        NAME_MAX = [40, 25, 25];
        DESC_MAX = [200, 120,  50];
        CTA_MAX = [30, 30, 15];
        CTA_LINK_MAX = [500,500,500];
    }


    // --- Public functions ---

    function configBanner(
        BannerType bannerType,
        string calldata _heading,
        string calldata _subtitle,
        Feature[3] calldata _features
    ) external onlyRole(OPERATOR) {
        _updateBannerInfo(bannerType, _heading, _subtitle);
        for (uint8 i = 0; i < _features.length; i++) {
            _updateFeature(
                bannerType,
                i,
                _features[i].name,
                _features[i].description,
                _features[i].cta,
                _features[i].ctaLink
            );
        }
    }

    function updateBannerInfo(
        BannerType bannerType,
        string calldata _heading,
        string calldata _subtitle
    ) external onlyRole(OPERATOR) {
        _updateBannerInfo(bannerType, _heading, _subtitle);
    }

    function updateFeature(
        BannerType bannerType,
        uint8[] calldata _featureIndexes,
        string[] calldata _names,
        string[] calldata _descriptions,
        string[] calldata _ctas,
        string[] calldata _ctaLinks
    ) external onlyRole(OPERATOR) {
        require(_featureIndexes.length <= 3, "Invalid length");
        for (uint8 i = 0; i < _featureIndexes.length; i++) {
            _updateFeature(
                bannerType,
                _featureIndexes[i],
                _names[i],
                _descriptions[i],
                _ctas[i],
                _ctaLinks[i]
            );
        }
    }

    // --- Getters ---

    function getBanner(
        BannerType bannerType
    )
        external
        view
        returns (
            string memory heading,
            string memory subtitle,
            Feature[3] memory features
        )
    {
        BannerData storage b = banners[bannerType];
        return (b.heading, b.subtitle, b.features);
    }

    function getFeature(
        BannerType bannerType,
        uint8 index
    ) external view returns (Feature memory) {
        require(index < 3, "Invalid feature index");
        return banners[bannerType].features[index];
    }

    // --- Internal updates ---

    function _updateBannerInfo(
        BannerType bannerType,
        string calldata _heading,
        string calldata _subtitle
    ) internal {
        _validateLength(_heading, 1, 150);
        banners[bannerType].heading = _heading;
        _validateLength(_subtitle, 1, 200);
        banners[bannerType].subtitle = _subtitle;
        emit BannerInfoUpdated(
            bannerType == BannerType.LEGACY ? "LEGACY" : "TIMELOCK",
            _heading,
            _subtitle
        );
    }

    function _updateFeature(
        BannerType bannerType,
        uint8 featureIndex,
        string calldata name,
        string calldata description,
        string calldata cta,
        string calldata ctaLink
    ) internal {
        require(featureIndex < 3, "Invalid featureIndex");


        _validateLength(name, 1, NAME_MAX[featureIndex]);
        _validateLength(description, 1,DESC_MAX[featureIndex]);
        _validateLength(cta, 1, CTA_MAX[featureIndex]);
        _validateLength(ctaLink, 1, CTA_LINK_MAX[featureIndex]);
        
        banners[bannerType].features[featureIndex] = Feature(
            name,
            description,
            cta,
            ctaLink
        );
        emit FeatureUpdated(
            bannerType == BannerType.LEGACY ? "LEGACY" : "TIMELOCK",
            featureIndex,
            name,
            description,
            cta,
            ctaLink
        );
    }


    function _validateLength(string memory str, uint256 minLength, uint256 maxLength) internal pure{
        uint256 len = bytes(str).length;
        if( len < minLength) revert InvalidLength(str, minLength, maxLength);
        if( len > maxLength) revert InvalidLength(str, minLength, maxLength);
    }

    function setMaxLengths(    
    uint16[3] calldata nameMax,
    uint16[3] calldata descMax,
    uint16[3] calldata ctaMax,
    uint16[3] calldata ctaLinkMax) external onlyRole(OPERATOR)  {
        NAME_MAX = nameMax;
        DESC_MAX = descMax;
        CTA_MAX = ctaMax;
        CTA_LINK_MAX = ctaLinkMax;
    }
}
