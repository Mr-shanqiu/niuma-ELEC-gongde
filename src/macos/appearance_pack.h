#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface NMAppearancePack : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) NSString *nameZH;
@property(nonatomic, copy) NSString *nameEN;
@property(nonatomic, copy) NSString *author;
@property(nonatomic, copy) NSString *publisher;
@property(nonatomic, copy) NSString *reviewID;
@property(nonatomic, strong) NSURL *directoryURL;
@property(nonatomic, strong) NSImage *previewImage;
@property(nonatomic, copy) NSArray<NSDictionary *> *layers;
@property(nonatomic, copy) NSDictionary<NSString *, NSImage *> *images;
@property(nonatomic) CGFloat plusY;
- (NSString *)localizedName;
- (void)drawAtPhase:(CGFloat)phase;
@end

@interface NMAppearancePackStore : NSObject
// Platform deliveries require a trusted V1 timed or V2 perpetual license.
// Neither mode uses the local clock as an import or offline-use gate.
+ (NSURL *)packsDirectoryURL;
+ (NSArray<NMAppearancePack *> *)loadInstalledPacks:(NSError **)error;
+ (nullable NMAppearancePack *)installArchiveAtURL:(NSURL *)archiveURL error:(NSError **)error;
+ (nullable NSArray<NMAppearancePack *> *)installBatchArchiveAtURL:(NSURL *)archiveURL error:(NSError **)error;
+ (BOOL)removePack:(NMAppearancePack *)pack error:(NSError **)error;
+ (nullable NMAppearancePack *)validatePackDirectory:(NSURL *)directoryURL error:(NSError **)error;
@end

NS_ASSUME_NONNULL_END
